// Recuperación de contraseña por código de 6 dígitos enviado al correo. Sección 8.3 y 11.6 de la especificación.
//
// Cuatro garantías:
//  - La respuesta de "solicitar" es siempre la misma y no espera al correo, así ni el contenido ni el tiempo
//    revelan si la cuenta existe (H23).
//  - El código se guarda como HMAC-SHA256 con una llave que NO vive en la base: un hash simple no sirve, porque un
//    millón de combinaciones se prueba en segundos si se filtra la tabla.
//  - Verificar y restablecer bloquean la fila (`FOR UPDATE`): dos peticiones simultáneas no consumen el mismo código.
//  - Un error de política o de historial en "restablecer" no consume el token.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { OTP, secretoAuth } from './configuracion.js';
import { hashear } from './contrasenas.js';
import { ErrorAuth, MENSAJES, limiteExcedido } from './errores.js';
import { correoDisponible, enviarCorreo } from './correo.js';
import { registrarEvento } from './eventos.js';
import { limites } from './limites.js';
import { plantillaCodigo } from './plantillas.js';
import { MENSAJE_CLAVE_PROHIBIDA, esClaveProhibida } from './claves-comunes.js';
import { cumplePolitica } from './politica.js';
import { avisarContrasenaCambiada, buscarActivaPorCorreo, claveYaUsada, conTransaccion, guardarContrasena } from './cuentas.js';
import { revocarSesionesDeUsuario } from './sesiones.js';

export const normalizarCorreo = (s: string) => s.normalize('NFKC').trim().toLowerCase();

const hmacCodigo = (usuario: string, codigo: string): Buffer => createHmac('sha256', secretoAuth()).update(`${usuario}:${codigo}`).digest();
const sha256 = (v: string) => createHash('sha256').update(v).digest();

export interface Origen {
  ip: string | null;
  /** Clave para los contadores (la IP, o `sin-ip`). */
  claveIp: string;
  agente: string | null;
}

// ------------------------------------------------------------------------------------ solicitar
/**
 * Paso 1. Trabajo en segundo plano: ya se respondió. Nunca lanza (el llamador lo ejecuta sin esperar) y nunca
 * registra el código.
 */
export async function procesarSolicitud(correoBruto: string, origen: Origen): Promise<void> {
  const correo = normalizarCorreo(correoBruto);
  const cuenta = await buscarActivaPorCorreo(correo);
  if (!cuenta || !cuenta.correo) return; // en silencio: no se revela nada

  const codigo = String(randomInt(0, 10 ** OTP.digitos)).padStart(OTP.digitos, '0');
  const vence = new Date(Date.now() + OTP.vigenciaMs);

  const creado = await conTransaccion(async (cli) => {
    // Evita que dos solicitudes simultáneas de la misma cuenta pasen la comprobación de frecuencia a la vez.
    await cli.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`otp:${cuenta.usuario}`]);
    const { rows } = await cli.query<{ ultimo_s: number | null; ultima_hora: number }>(
      `SELECT extract(epoch FROM now() - max(creado_at))::float8 AS ultimo_s,
              count(*) FILTER (WHERE creado_at > now() - interval '1 hour')::int AS ultima_hora
         FROM panel.codigos_recuperacion WHERE usuario = $1`,
      [cuenta.usuario],
    );
    const { ultimo_s: ultimoS, ultima_hora: ultimaHora } = rows[0];
    // 1 cada 60 s y 3 por hora por cuenta (RF-14): se sigue respondiendo igual, pero no se procesa.
    if ((ultimoS !== null && ultimoS < OTP.reenvioMs / 1000) || ultimaHora >= OTP.porHoraMax) return false;
    // Un código nuevo anula el anterior.
    await cli.query(`UPDATE panel.codigos_recuperacion SET anulado_at = now() WHERE usuario = $1 AND usado_at IS NULL AND anulado_at IS NULL`, [cuenta.usuario]);
    await cli.query(
      `INSERT INTO panel.codigos_recuperacion (usuario, codigo_hmac, expira_at, ip) VALUES ($1, $2, $3::timestamptz, $4::inet)`,
      [cuenta.usuario, hmacCodigo(cuenta.usuario, codigo), vence.toISOString(), origen.ip],
    );
    return true;
  });
  if (!creado) return;

  await registrarEvento({ tipo: 'otp_solicitado', usuario: cuenta.usuario, ip: origen.ip, agente: origen.agente });
  const p = plantillaCodigo(codigo, vence, OTP.vigenciaMs / 60_000);
  const r = await enviarCorreo({ para: [cuenta.correo], asunto: p.asunto, texto: p.texto, html: p.html });
  // El evento NO lleva el código ni el destinatario.
  if (!r.ok) await registrarEvento({ tipo: 'correo_fallido', usuario: cuenta.usuario, ip: origen.ip, agente: origen.agente, detalle: `código de recuperación: ${r.error ?? 'error'}` });
}

/** Para la ruta: dispara el trabajo en segundo plano capturando cualquier error. */
export function solicitarEnSegundoPlano(correo: string, origen: Origen) {
  setImmediate(() => {
    procesarSolicitud(correo, origen).catch((e) => console.error('No se pudo procesar la solicitud de código:', (e as Error).message));
  });
}

export const recuperacionDisponible = () => correoDisponible();

// ------------------------------------------------------------------------------------ verificar
type Intento = { ok: true; token: string; usuario: string } | { ok: false; usuario: string | null };

/** Paso 2. Devuelve el token de restablecimiento (de un solo uso, 10 minutos) si el código es correcto. */
export async function verificarCodigo(correoBruto: string, codigo: string, origen: Origen): Promise<string> {
  const correo = normalizarCorreo(correoBruto);
  const claveCorreoIp = `${correo}|${origen.claveIp}`;
  const espera = Math.max(limites.otpCorreoIp.espera(claveCorreoIp), limites.otpIp.espera(origen.claveIp));
  if (espera > 0) throw limiteExcedido(espera);

  const cuenta = await buscarActivaPorCorreo(correo);
  const intento = await conTransaccion<Intento>(async (cli) => {
    // Misma ruta de ejecución exista o no la cuenta (mismo número de consultas y un HMAC calculado igual).
    // Un nombre que ningún usuario válido puede tener (los usuarios son [A-Za-z0-9._-]).
    const usuario = cuenta?.usuario ?? '*sin-cuenta*';
    const { rows } = await cli.query<{ id: string; codigo_hmac: Buffer; intentos: number; expira_at: Date }>(
      `SELECT id, codigo_hmac, intentos, expira_at FROM panel.codigos_recuperacion
        WHERE usuario = $1 AND usado_at IS NULL AND anulado_at IS NULL
        ORDER BY creado_at DESC LIMIT 1 FOR UPDATE`,
      [usuario],
    );
    const calculado = hmacCodigo(usuario, codigo);
    const fila = rows[0];
    if (!cuenta || !fila || fila.expira_at.getTime() <= Date.now() || fila.intentos >= OTP.intentosMax) {
      return { ok: false, usuario: cuenta?.usuario ?? null };
    }
    if (calculado.length !== fila.codigo_hmac.length || !timingSafeEqual(calculado, fila.codigo_hmac)) {
      const intentos = fila.intentos + 1;
      await cli.query(
        `UPDATE panel.codigos_recuperacion SET intentos = $2::int, anulado_at = CASE WHEN $2::int >= $3::int THEN now() ELSE anulado_at END WHERE id = $1`,
        [fila.id, intentos, OTP.intentosMax],
      );
      return { ok: false, usuario: cuenta.usuario };
    }
    const token = randomBytes(OTP.tokenBytes).toString('base64url');
    await cli.query(
      `UPDATE panel.codigos_recuperacion SET usado_at = now(), token_hash = $2, token_expira_at = $3::timestamptz WHERE id = $1`,
      [fila.id, sha256(token), new Date(Date.now() + OTP.tokenVigenciaMs).toISOString()],
    );
    return { ok: true, token, usuario: cuenta.usuario };
  });

  if (!intento.ok) {
    limites.otpCorreoIp.fallo(claveCorreoIp);
    limites.otpIp.fallo(origen.claveIp);
    if (intento.usuario) await registrarEvento({ tipo: 'otp_fallido', usuario: intento.usuario, ip: origen.ip, agente: origen.agente });
    // Con el fallo que alcanza el tope ya se responde 429 (con Retry-After), igual que en el login.
    const bloqueo = Math.max(limites.otpCorreoIp.espera(claveCorreoIp), limites.otpIp.espera(origen.claveIp));
    throw bloqueo > 0 ? limiteExcedido(bloqueo) : new ErrorAuth(400, 'otp', MENSAJES.otp);
  }
  limites.otpCorreoIp.limpiar(claveCorreoIp);
  await registrarEvento({ tipo: 'otp_validado', usuario: intento.usuario, ip: origen.ip, agente: origen.agente });
  return intento.token;
}

// ---------------------------------------------------------------------------------- restablecer
/** Reglas de la contraseña nueva que dependen de la cuenta (política + claves prohibidas). Lanza 400. */
export function exigirClaveValida(nueva: string, ctx: { usuario: string; correo: string | null }) {
  if (!cumplePolitica(nueva)) throw new ErrorAuth(400, 'politica', MENSAJES.politica);
  if (esClaveProhibida(nueva, ctx)) throw new ErrorAuth(400, 'politica', MENSAJE_CLAVE_PROHIBIDA);
}

/** Paso 3. Cambia la contraseña con el token del paso 2, cierra todas las sesiones y avisa por correo. */
export async function restablecer(token: string, nuevaBruta: string, origen: Origen): Promise<void> {
  const nueva = nuevaBruta.normalize('NFKC');
  // La política se valida primero y sin tocar el token: un error de política no lo consume.
  if (!cumplePolitica(nueva)) throw new ErrorAuth(400, 'politica', MENSAJES.politica);
  if (limites.otpIp.espera(origen.claveIp) > 0) throw limiteExcedido(limites.otpIp.espera(origen.claveIp));

  const resultado = await conTransaccion<{ usuario: string; correo: string | null } | 'token' | 'historial' | 'politica'>(async (cli: PoolClient) => {
    const { rows } = await cli.query<{ id: string; usuario: string; correo: string | null }>(
      `SELECT c.id, c.usuario, u.correo FROM panel.codigos_recuperacion c JOIN panel.usuarios u ON u.usuario = c.usuario
        WHERE c.token_hash = $1 AND c.token_usado_at IS NULL AND c.token_expira_at > now() AND u.activo FOR UPDATE OF c`,
      [sha256(token)],
    );
    const fila = rows[0];
    if (!fila) return 'token';
    if (esClaveProhibida(nueva, { usuario: fila.usuario, correo: fila.correo })) return 'politica';
    if (await claveYaUsada(cli, fila.usuario, nueva)) return 'historial';
    await guardarContrasena(cli, fila.usuario, await hashear(nueva), { debeCambiar: false, temporalExpiraAt: null });
    await cli.query(`UPDATE panel.codigos_recuperacion SET token_usado_at = now() WHERE id = $1`, [fila.id]);
    return { usuario: fila.usuario, correo: fila.correo };
  });

  if (resultado === 'token') {
    limites.otpIp.fallo(origen.claveIp);
    throw new ErrorAuth(400, 'token', MENSAJES.token);
  }
  // Ni 'politica' ni 'historial' consumen el token: la transacción solo leyó.
  if (resultado === 'politica') throw new ErrorAuth(400, 'politica', MENSAJE_CLAVE_PROHIBIDA);
  if (resultado === 'historial') throw new ErrorAuth(400, 'historial', MENSAJES.historial);

  // Tras el COMMIT: cerrar todas las sesiones (la caché se invalida en el mismo paso), dejar constancia y avisar.
  await revocarSesionesDeUsuario(resultado.usuario, 'contrasena');
  await registrarEvento({ tipo: 'contrasena_restablecida', usuario: resultado.usuario, ip: origen.ip, agente: origen.agente });
  void avisarContrasenaCambiada(resultado.usuario, resultado.correo, origen.ip, origen.agente);
}
