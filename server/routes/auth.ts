// Rutas de autenticación: login, cierre de sesión, recuperación por código, cambio de contraseña y sesiones propias.
// Especificación: proyecto-ips/docs/features/2026-11-04-panel-login-autenticacion.md, secciones 10 y 11.6.
//
// REGLAS: no se registra el cuerpo de ninguna de estas peticiones; toda validación de seguridad ocurre aquí, en el
// servidor; los mensajes de error no revelan si una cuenta existe.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { queryApp } from '../db.js';
import { hashear, verificar, verificarFicticia } from '../auth/contrasenas.js';
import { ErrorAuth, MENSAJES, limiteExcedido } from '../auth/errores.js';
import { eventoDe } from '../auth/eventos.js';
import {
  claveIdIp, exigirLoginPermitido, limites, normalizarIdentificador, registrarFalloLogin, registrarLoginCorrecto,
  type Limitador,
} from '../auth/limites.js';
import { agenteDe, claveIp, ipDe } from '../auth/red.js';
import {
  borrarCookie, crearSesion, listarSesiones, marcarReautenticada, ponerCookie, resolverSesion, revocarSesion,
  revocarSesionesDeUsuario, rotarToken,
} from '../auth/sesiones.js';
import { avisarContrasenaCambiada, buscarPorIdentificador, buscarPorUsuario, claveYaUsada, conTransaccion, guardarContrasena } from '../auth/cuentas.js';
import { exigirClaveValida, recuperacionDisponible, restablecer, solicitarEnSegundoPlano, verificarCodigo, type Origen } from '../auth/otp.js';

const LIMITE_CUERPO = 4096;
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** Mensaje de la pantalla de acceso cuando el correo no está configurado (RF-18). */
const MENSAJE_SIN_CORREO = 'No disponible por ahora. Contacte a soporte.';

const origenDe = (req: FastifyRequest): Origen => ({ ip: ipDe(req), claveIp: claveIp(req), agente: agenteDe(req) });

/**
 * Cuenta un fallo en un limitador. Si con él se alcanzó el tope, responde 429 en lugar del error normal: así el
 * quinto fallo ya trae el `Retry-After`.
 */
function contarFallo(limitador: Limitador, clave: string, error: ErrorAuth): never {
  limitador.fallo(clave);
  const espera = limitador.espera(clave);
  throw espera > 0 ? limiteExcedido(espera) : error;
}

const sinContenido = (reply: FastifyReply) => reply.code(204).send();

export default async function rutasAuth(app: FastifyInstance) {
  // ------------------------------------------------------------------------------------- login
  app.post(
    '/api/auth/login',
    {
      bodyLimit: LIMITE_CUERPO,
      schema: {
        body: {
          type: 'object',
          required: ['usuario', 'contrasena'],
          additionalProperties: false,
          properties: {
            usuario: { type: 'string', minLength: 1, maxLength: 150 },
            contrasena: { type: 'string', minLength: 1, maxLength: 256 },
            mantener: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { usuario: string; contrasena: string; mantener?: boolean };
      const ip = claveIp(req);
      const id = normalizarIdentificador(b.usuario);
      exigirLoginPermitido(ip, id);

      const cuenta = await buscarPorIdentificador(id);
      const usable = !!cuenta && cuenta.activo && !!cuenta.hash;
      let correcto = false;
      let rehacer = false;
      if (usable) {
        const v = await verificar(b.contrasena, cuenta.hash!);
        correcto = v.ok;
        rehacer = v.rehacer;
      } else {
        // Cuenta inexistente, inactiva o sin contraseña: se deriva igual para que tarde lo mismo (H23).
        await verificarFicticia(b.contrasena);
      }

      if (!correcto) {
        const cuentaBloqueada = registrarFalloLogin(ip, id);
        // Si el identificador no existe, `usuario` va NULL: la persona pudo escribir su contraseña en ese campo.
        await eventoDe(req, { tipo: 'login_fallido', usuario: cuenta?.usuario ?? null });
        if (cuentaBloqueada && cuenta) await eventoDe(req, { tipo: 'cuenta_bloqueada', usuario: cuenta.usuario });
        const espera = Math.max(limites.loginIp.espera(ip), limites.loginIdentificadorIp.espera(claveIdIp(id, ip)), limites.loginIdentificador.espera(id));
        throw espera > 0 ? limiteExcedido(espera) : new ErrorAuth(401, 'credenciales', MENSAJES.credenciales);
      }

      const c = cuenta!;
      if (c.debeCambiar && c.temporalExpiraAt && c.temporalExpiraAt.getTime() < Date.now()) {
        await eventoDe(req, { tipo: 'login_fallido', usuario: c.usuario, detalle: 'contraseña temporal vencida' });
        throw new ErrorAuth(403, 'temporal_vencida', 'La contraseña temporal venció. Pida una nueva a soporte.');
      }
      // Parámetros de scrypt más débiles que los vigentes: se rehace el hash con la contraseña que acaba de escribir.
      if (rehacer) await queryApp(`UPDATE panel.credenciales SET hash = $2 WHERE usuario = $1`, [c.usuario, await hashear(b.contrasena)]);

      // Si llega con una cookie de sesión válida, se revoca antes de crear la nueva (fijación de sesión).
      const previa = await resolverSesion(req);
      if (previa) await revocarSesion(previa.id, 'logout');

      const sesion = await crearSesion(c.usuario, !!b.mantener, req);
      ponerCookie(reply, sesion.token, sesion.mantener);
      registrarLoginCorrecto(ip, id);
      await eventoDe(req, { tipo: 'login_ok', usuario: c.usuario });
      return { debeCambiar: c.debeCambiar };
    },
  );

  // ------------------------------------------------------------------------------------ logout
  // Pública y sin contexto: cerrar sesión sin tener una (o con una vencida) no es un error. Idempotente.
  app.post('/api/auth/logout', async (req, reply) => {
    const s = await resolverSesion(req);
    if (s) {
      await revocarSesion(s.id, 'logout');
      await eventoDe(req, { tipo: 'logout', usuario: s.usuario });
    }
    borrarCookie(reply);
    return sinContenido(reply);
  });

  // ------------------------------------------------------------------------------------ latido
  // La actividad real ya la marcó el hook de acceso: aquí no hay nada más que hacer.
  app.post('/api/auth/latido', async (_req, reply) => sinContenido(reply));

  // ------------------------------------------------------------------------------- recuperación
  app.post(
    '/api/auth/recuperar/solicitar',
    { bodyLimit: LIMITE_CUERPO, schema: { body: { type: 'object', required: ['correo'], additionalProperties: false, properties: { correo: { type: 'string', minLength: 1, maxLength: 150 } } } } },
    async (req) => {
      // Sin correo configurado el login funciona, pero no se puede recuperar. No revela nada de ninguna cuenta.
      if (!recuperacionDisponible()) throw new ErrorAuth(503, 'correo', MENSAJE_SIN_CORREO);
      const origen = origenDe(req);
      // Superado el límite por IP se sigue respondiendo igual, sin procesar.
      if (limites.recuperarIp.intentar(origen.claveIp)) solicitarEnSegundoPlano((req.body as { correo: string }).correo, origen);
      // Respuesta inmediata e idéntica: nunca se espera al correo, el tiempo delataría si la cuenta existe.
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/recuperar/verificar',
    {
      bodyLimit: LIMITE_CUERPO,
      schema: {
        body: {
          type: 'object',
          required: ['correo', 'codigo'],
          additionalProperties: false,
          properties: { correo: { type: 'string', minLength: 1, maxLength: 150 }, codigo: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (req) => {
      const b = req.body as { correo: string; codigo: string };
      return { token: await verificarCodigo(b.correo, b.codigo, origenDe(req)) };
    },
  );

  app.post(
    '/api/auth/recuperar/restablecer',
    {
      bodyLimit: LIMITE_CUERPO,
      schema: {
        body: {
          type: 'object',
          required: ['token', 'nueva'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 10, maxLength: 100 }, nueva: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { token: string; nueva: string };
      await restablecer(b.token, b.nueva, origenDe(req));
      return sinContenido(reply);
    },
  );

  // ---------------------------------------------------------------------------------- contraseña
  app.post(
    '/api/auth/contrasena',
    {
      bodyLimit: LIMITE_CUERPO,
      schema: {
        body: {
          type: 'object',
          required: ['nueva'],
          additionalProperties: false,
          properties: { actual: { type: 'string', maxLength: 256 }, nueva: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req, reply) => {
      const ctx = req.contexto!;
      const sesion = req.sesionPanel!;
      const usuario = ctx.usuario!;
      const b = req.body as { actual?: string; nueva: string };

      const espera = limites.contrasenaUsuario.espera(usuario);
      if (espera > 0) throw limiteExcedido(espera);

      const cuenta = await buscarPorUsuario(usuario);
      if (!cuenta) throw new ErrorAuth(401, 'sesion', MENSAJES.sesion);

      // La actual es obligatoria, salvo con contraseña temporal: la persona acaba de escribirla para entrar.
      if (!ctx.debeCambiar) {
        const ok = !!b.actual && !!cuenta.hash && (await verificar(b.actual, cuenta.hash)).ok;
        if (!ok) contarFallo(limites.contrasenaUsuario, usuario, new ErrorAuth(400, 'actual', MENSAJES.actual));
        limites.contrasenaUsuario.limpiar(usuario);
      }

      const nueva = b.nueva.normalize('NFKC');
      exigirClaveValida(nueva, { usuario, correo: cuenta.correo });

      await conTransaccion(async (cli) => {
        if (await claveYaUsada(cli, usuario, nueva)) throw new ErrorAuth(400, 'historial', MENSAJES.historial);
        await guardarContrasena(cli, usuario, await hashear(nueva), { debeCambiar: false, temporalExpiraAt: null });
      });

      // Las demás sesiones se cierran; la actual conserva el acceso con un token nuevo (el anterior deja de servir).
      await revocarSesionesDeUsuario(usuario, 'contrasena', sesion.id);
      sesion.debeCambiar = false;
      ponerCookie(reply, await rotarToken(sesion), sesion.mantener);
      await eventoDe(req, { tipo: 'contrasena_cambiada', usuario });
      void avisarContrasenaCambiada(usuario, cuenta.correo, ipDe(req), agenteDe(req));
      return sinContenido(reply);
    },
  );

  // Confirmar la contraseña antes de una acción sensible (D6): vale 10 minutos.
  app.post(
    '/api/auth/reautenticar',
    { bodyLimit: LIMITE_CUERPO, schema: { body: { type: 'object', required: ['contrasena'], additionalProperties: false, properties: { contrasena: { type: 'string', minLength: 1, maxLength: 256 } } } } },
    async (req, reply) => {
      const usuario = req.contexto!.usuario!;
      const espera = limites.contrasenaUsuario.espera(usuario);
      if (espera > 0) throw limiteExcedido(espera);
      const cuenta = await buscarPorUsuario(usuario);
      const ok = !!cuenta?.hash && (await verificar((req.body as { contrasena: string }).contrasena, cuenta.hash)).ok;
      if (!ok) contarFallo(limites.contrasenaUsuario, usuario, new ErrorAuth(400, 'actual', MENSAJES.actual));
      limites.contrasenaUsuario.limpiar(usuario);
      await marcarReautenticada(req.sesionPanel!);
      return sinContenido(reply);
    },
  );

  // ------------------------------------------------------------------------------------ sesiones
  app.get('/api/auth/sesiones', async (req) => ({ filas: await listarSesiones(req.contexto!.usuario!, req.contexto!.sesionId) }));

  app.delete(
    '/api/auth/sesiones/:id',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const usuario = req.contexto!.usuario!;
      // Solo se puede cerrar una sesión propia.
      if (!(await revocarSesion(id, 'usuario', usuario))) return reply.code(404).send({ error: 'La sesión no existe o ya está cerrada', codigo: 'no_existe' });
      await eventoDe(req, { tipo: 'sesion_revocada', usuario, detalle: 'cerrada por la propia persona' });
      if (id === req.contexto!.sesionId) borrarCookie(reply);
      return sinContenido(reply);
    },
  );

  app.post('/api/auth/sesiones/cerrar-otras', async (req) => {
    const usuario = req.contexto!.usuario!;
    const cerradas = await revocarSesionesDeUsuario(usuario, 'usuario', req.contexto!.sesionId ?? undefined);
    if (cerradas) await eventoDe(req, { tipo: 'sesion_revocada', usuario, detalle: `cerró las demás sesiones (${cerradas})` });
    return { cerradas };
  });
}
