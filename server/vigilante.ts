// Vigilante del rol soporte: cada 5 minutos revisa la salud técnica del sistema (backend, bot, scraper, base de
// datos, despliegues, lista de espera, el propio panel) y mantiene el ciclo de vida de cada alerta en
// panel.alertas: activa → revisada / silenciada → resuelta (sola, cuando la condición desaparece).
// Las alertas solo se ven en la consola de soporte; no se envían por correo ni por mensaje (decisión de German).
import { pool, poolApp, query, queryApp, queryOne } from './db.js';
import { erroresRecientes } from './acceso.js';
import { ENLACE_ALERTA, alertasActivas } from './routes/alertas.js';
import { HOY } from './sql.js';

export type Grupo = 'disponibilidad' | 'despliegue' | 'integraciones' | 'lista_espera' | 'panel';

export interface AlertaTecnica {
  clave: string;
  grupo: Grupo;
  severidad: 'alta' | 'media' | 'baja';
  titulo: string;
  detalle: string;
  impacto: string;
  /** Pantalla del panel donde se investiga (#/...), o null si hay que ir al servidor. */
  enlace: string | null;
}

export interface Comprobacion {
  nombre: string;
  grupo: Grupo;
  ok: boolean;
  ms: number;
  error?: string;
}

const INTERVALO_MS = 5 * 60_000;
const TIMEOUT_HTTP_MS = 6_000;

// URL vacía = no se comprueba (desarrollo local, donde esos contenedores no existen).
const url = (nombre: string, defecto: string) => (process.env[nombre] === undefined ? defecto : process.env[nombre]!.trim());
const BACKEND_URL = url('VIGILANTE_BACKEND_URL', 'http://ips-centro-orientacion-backend-1:8000');
const SCRAPER_URL = url('VIGILANTE_SCRAPER_URL', 'http://ips-centro-orientacion-scraper-1:3000');
const BOT_URL = url('VIGILANTE_BOT_URL', 'https://chatbotips.zentrixsolucionesdigitales.com');

// Fallos consecutivos por comprobación HTTP: se alerta a partir del segundo, para no reaccionar a un parpadeo.
const fallosSeguidos = new Map<string, number>();

let ultima: { at: string; ms: number; comprobaciones: Comprobacion[]; detectadas: number } | null = null;
let corriendo = false;

export const estadoVigilante = () => ultima;

async function http(nombre: string, destino: string, okSi: (status: number) => boolean): Promise<{ ok: boolean; detalle: string }> {
  try {
    const res = await fetch(destino, { signal: AbortSignal.timeout(TIMEOUT_HTTP_MS), redirect: 'manual' });
    const ok = okSi(res.status);
    return { ok, detalle: `${nombre} respondió ${res.status}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, detalle: `${nombre} no respondió (${err.cause?.code ?? err.name})` };
  }
}

type Regla = (out: AlertaTecnica[]) => Promise<void>;

function reglasHttp(): { nombre: string; grupo: Grupo; fn: Regla }[] {
  const lista: { nombre: string; destino: string; okSi: (s: number) => boolean; titulo: string; impacto: string; sev: 'alta' | 'media' }[] = [];
  if (BACKEND_URL) {
    lista.push({
      nombre: 'Backend', destino: `${BACKEND_URL}/health`, okSi: (s) => s === 200, sev: 'alta',
      titulo: 'El backend no responde',
      impacto: 'El bot no puede agendar, cancelar ni confirmar citas. Revisar el contenedor ips-centro-orientacion-backend-1.',
    });
  }
  if (SCRAPER_URL) {
    lista.push({
      nombre: 'Scraper', destino: `${SCRAPER_URL}/health`, okSi: (s) => s === 200, sev: 'media',
      titulo: 'El scraper no responde',
      impacto: 'La agenda deja de copiarse desde Globho. Revisar el contenedor ips-centro-orientacion-scraper-1.',
    });
  }
  if (BOT_URL) {
    // El bot no tiene /health; cualquier respuesta de la aplicación (incluso 4xx del webhook) prueba que está vivo.
    // nginx responde 502/504 cuando el proceso de PM2 está caído.
    lista.push({
      nombre: 'Bot', destino: `${BOT_URL}/webhook`, okSi: (s) => s < 500, sev: 'alta',
      titulo: 'El bot de WhatsApp no responde',
      impacto: 'Los pacientes no reciben respuesta y las campañas no se envían. Revisar `pm2 status bot-meta` en el droplet.',
    });
  }
  return lista.map((c) => ({
    nombre: c.nombre,
    grupo: 'disponibilidad' as const,
    fn: async (out) => {
      const r = await http(c.nombre, c.destino, c.okSi);
      const n = r.ok ? 0 : (fallosSeguidos.get(c.nombre) ?? 0) + 1;
      fallosSeguidos.set(c.nombre, n);
      if (n >= 2) {
        out.push({ clave: `http:${c.nombre.toLowerCase()}`, grupo: 'disponibilidad', severidad: c.sev, titulo: c.titulo, detalle: `${r.detalle}. Falló ${n} revisiones seguidas.`, impacto: c.impacto, enlace: null });
      }
    },
  }));
}

const REGLAS: { nombre: string; grupo: Grupo; fn: Regla }[] = [
  {
    nombre: 'Latencia de Postgres',
    grupo: 'disponibilidad',
    fn: async (out) => {
      const t = Date.now();
      await pool.query('SELECT 1');
      const ms = Date.now() - t;
      const n = ms > 1_500 ? (fallosSeguidos.get('pg') ?? 0) + 1 : 0;
      fallosSeguidos.set('pg', n);
      if (n >= 2) {
        out.push({
          clave: 'pg:lenta', grupo: 'disponibilidad', severidad: 'media',
          titulo: 'La base de datos responde lento',
          detalle: `Una consulta trivial tardó ${ms} ms (${n} revisiones seguidas por encima de 1,5 s).`,
          impacto: 'El bot y el panel se vuelven lentos. Revisar memoria y CPU del droplet (`docker stats`).',
          enlace: null,
        });
      }
    },
  },
  {
    // Reversión del bot (como la del 2026-10-01): vuelven a llegar eventos del formato antiguo y dejan de llegar
    // los de trazabilidad v2. Solo se evalúa si v2 estuvo activo en la última semana.
    nombre: 'Versión del bot (trazabilidad v2)',
    grupo: 'despliegue',
    fn: async (out) => {
      const r = await queryOne<{ v2_semana: number; v2_6h: number; v1_6h: number; ultimo_v2: string | null }>(
        `SELECT count(*) FILTER (WHERE version_esquema = 2) AS v2_semana,
                count(*) FILTER (WHERE version_esquema = 2 AND fecha_hora > (now() AT TIME ZONE 'UTC') - interval '6 hours') AS v2_6h,
                count(*) FILTER (WHERE coalesce(version_esquema, 1) = 1 AND fecha_hora > (now() AT TIME ZONE 'UTC') - interval '6 hours'
                                   AND coalesce(id_usuario, '') NOT LIKE 'EJECUCION%') AS v1_6h,
                to_char(max(fecha_hora) FILTER (WHERE version_esquema = 2) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS ultimo_v2
           FROM chat_stats
          WHERE fecha_hora > (now() AT TIME ZONE 'UTC') - interval '7 days'`,
      );
      if (r.v2_semana > 0 && r.v2_6h === 0 && r.v1_6h >= 10) {
        out.push({
          clave: 'despliegue:trazabilidad_v1', grupo: 'despliegue', severidad: 'alta',
          titulo: 'El bot parece haber vuelto a una versión anterior',
          detalle: `En las últimas 6 horas llegaron ${r.v1_6h} eventos del formato antiguo y ninguno de trazabilidad v2 (último v2: ${r.ultimo_v2 ?? '—'}).`,
          impacto: 'Se pierde la trazabilidad detallada (envíos, pasos, sesiones). Revisar el commit desplegado del bot o la variable TRAZABILIDAD_V2_ENABLED.',
          enlace: null,
        });
      }
    },
  },
  {
    nombre: 'Actividad del bot en horario hábil',
    grupo: 'despliegue',
    fn: async (out) => {
      const r = await queryOne<{ habil: boolean; n: number }>(
        `SELECT extract(isodow FROM now() AT TIME ZONE 'America/Bogota') BETWEEN 1 AND 6
                AND (now() AT TIME ZONE 'America/Bogota')::time BETWEEN '08:00' AND '20:00'
                AND NOT coalesce((SELECT es_festivo FROM bi.dim_fecha WHERE fecha = ${HOY}), false) AS habil,
                (SELECT count(*) FROM chat_stats WHERE fecha_hora > (now() AT TIME ZONE 'UTC') - interval '3 hours') AS n`,
      );
      if (r.habil && r.n === 0) {
        out.push({
          clave: 'despliegue:bot_silencio', grupo: 'despliegue', severidad: 'media',
          titulo: 'El bot no registra ninguna actividad en 3 horas',
          detalle: 'Cero eventos en chat_stats durante horario hábil.',
          impacto: 'Puede que el bot esté caído o que no llegue al backend (`POST /api/stats`). Revisar `pm2 logs bot-meta`.',
          enlace: '#/alertas',
        });
      }
    },
  },
  {
    // Migraciones de proyecto-ips desde la 025: deben estar todas registradas y sin huecos.
    nombre: 'Migraciones del backend',
    grupo: 'despliegue',
    fn: async (out) => {
      const filas = await query<{ name: string }>(`SELECT name FROM migrations WHERE name ~ '^[0-9]{3}_'`);
      const nums = filas.map((f) => Number(f.name.slice(0, 3))).filter((n) => n >= 25);
      if (!nums.length) return;
      const max = Math.max(...nums);
      const faltan: number[] = [];
      for (let n = 25; n <= max; n++) if (!nums.includes(n)) faltan.push(n);
      if (faltan.length) {
        out.push({
          clave: 'despliegue:migraciones', grupo: 'despliegue', severidad: 'media',
          titulo: 'Faltan migraciones registradas en la base de datos',
          detalle: `No están en la tabla migrations: ${faltan.map((n) => String(n).padStart(3, '0')).join(', ')} (la última es la ${String(max).padStart(3, '0')}).`,
          impacto: 'El backend intentará aplicarlas al reiniciar; si no son idempotentes, puede no arrancar.',
          enlace: null,
        });
      }
    },
  },
  {
    nombre: 'Alertas operativas (campañas, WhatsApp, Globho)',
    grupo: 'integraciones',
    fn: async (out) => {
      const impactos: Record<string, string> = {
        campana_no_corrio: 'Los pacientes no reciben ese recordatorio. Revisar el contenedor cron y el endpoint de campañas del bot.',
        campana_sin_envios: 'Revisar el token de Meta, la plantilla o los logs del bot.',
        fallo_envio_alto: 'Revisar la calidad del número en Meta Business y el detalle de errores en Campañas.',
        scraper_sin_actualizar: 'Las métricas de agenda quedan desactualizadas y la lista de espera no detecta cupos.',
        bot_sin_conversaciones: 'Puede que el bot esté caído o que el webhook de Meta no llegue.',
        errores_bot: 'Revisar `pm2 logs bot-meta` y la pantalla Alertas.',
      };
      for (const a of await alertasActivas()) {
        out.push({
          clave: `integraciones:${a.alerta}${a.instancia ? `:${a.instancia}` : ''}`,
          grupo: 'integraciones',
          severidad: a.severidad,
          titulo: a.titulo,
          detalle: a.detalle,
          impacto: impactos[a.alerta] ?? 'Ver la pantalla Alertas.',
          enlace: ENLACE_ALERTA[a.alerta] ?? '#/alertas',
        });
      }
    },
  },
  {
    // Residuos de la cascada de lista de espera (como los que dejaron las pruebas del 2026-10-01).
    nombre: 'Estado de la lista de espera',
    grupo: 'lista_espera',
    fn: async (out) => {
      const r = await queryOne<{ vencidas: number; cupos_huerfanos: number; inscripciones_muertas: number; inv_abortadas: number; inv_colgadas: number }>(
        `WITH ahora AS (SELECT now() AT TIME ZONE 'UTC' AS t)
         SELECT
           (SELECT count(*) FROM ofertas_cupo, ahora WHERE estado = 'enviada' AND expira_at < ahora.t - interval '30 minutes') AS vencidas,
           (SELECT count(*) FROM cupos_liberados c, ahora WHERE c.estado = 'en_oferta'
               AND c.updated_at < ahora.t - interval '30 minutes'
               AND NOT EXISTS (SELECT 1 FROM ofertas_cupo o WHERE o.cupo_liberado_id = c.cupo_liberado_id
                                 AND o.estado = 'enviada' AND (o.expira_at IS NULL OR o.expira_at > ahora.t))) AS cupos_huerfanos,
           (SELECT count(*) FROM lista_espera l JOIN bi.fact_citas f ON f.agenda_id = l.cita_actual_id
             WHERE l.estado = 'activa' AND (f.estado_agenda IN ('Cancelado', 'Anulado', 'Asistio', 'No Asistio') OR f.fecha_cita < ${HOY})) AS inscripciones_muertas,
           (SELECT count(*) FROM ejecuciones_invitacion_lista_espera, ahora WHERE estado = 'abortada' AND iniciada_at > ahora.t - interval '24 hours') AS inv_abortadas,
           (SELECT count(*) FROM ejecuciones_invitacion_lista_espera, ahora WHERE estado = 'en_curso' AND iniciada_at < ahora.t - interval '2 hours') AS inv_colgadas`,
      );
      if (r.vencidas > 0) {
        out.push({
          clave: 'lista_espera:ofertas_vencidas', grupo: 'lista_espera', severidad: 'media',
          titulo: `${r.vencidas} ofertas de cupo vencidas siguen como "enviada"`,
          detalle: 'Pasaron más de 30 minutos de su vencimiento y la cascada no las cerró.',
          impacto: 'El índice único impide ofrecer otro cupo a esos pacientes y el cupo queda bloqueado. Revisar el poller de la cascada.',
          enlace: '#/lista-espera',
        });
      }
      if (r.cupos_huerfanos > 0) {
        out.push({
          clave: 'lista_espera:cupos_huerfanos', grupo: 'lista_espera', severidad: 'media',
          titulo: `${r.cupos_huerfanos} cupos "en oferta" sin ninguna oferta viva`,
          detalle: 'El cupo quedó marcado en oferta, pero no hay una oferta enviada vigente.',
          impacto: 'Ese cupo no se vuelve a ofrecer a nadie: hora de consulta perdida.',
          enlace: '#/lista-espera',
        });
      }
      if (r.inscripciones_muertas > 0) {
        out.push({
          clave: 'lista_espera:inscripciones_muertas', grupo: 'lista_espera', severidad: 'baja',
          titulo: `${r.inscripciones_muertas} inscripciones activas sobre citas que ya no existen`,
          detalle: 'La cita del paciente se canceló, se atendió o ya pasó, pero la inscripción sigue activa.',
          impacto: 'Esos pacientes pueden recibir ofertas que no les sirven. Revisar la sincronización con el scraper.',
          enlace: '#/lista-espera',
        });
      }
      if (r.inv_abortadas > 0 || r.inv_colgadas > 0) {
        out.push({
          clave: 'lista_espera:invitaciones', grupo: 'lista_espera', severidad: 'media',
          titulo: 'La campaña de invitación a la lista de espera tuvo problemas',
          detalle: `${r.inv_abortadas} ejecuciones abortadas en 24 h y ${r.inv_colgadas} en curso hace más de 2 horas.`,
          impacto: 'Los pacientes con citas lejanas no reciben la invitación. Revisar los logs del bot.',
          enlace: '#/lista-espera',
        });
      }
    },
  },
  {
    nombre: 'Errores del panel',
    grupo: 'panel',
    fn: async (out) => {
      const e = erroresRecientes(60 * 60_000);
      if (e.interno >= 5) {
        out.push({
          clave: 'panel:errores', grupo: 'panel', severidad: 'media',
          titulo: `${e.interno} errores internos del panel en la última hora`,
          detalle: 'Respuestas 500 a consultas del panel.',
          impacto: 'Algunas pantallas no cargan para el cliente. Revisar `docker logs panel-ips`.',
          enlace: null,
        });
      }
      if (e.timeout >= 3) {
        out.push({
          clave: 'panel:lento', grupo: 'panel', severidad: 'baja',
          titulo: `${e.timeout} consultas del panel canceladas por tiempo en la última hora`,
          detalle: 'Superaron el límite de 15 s del rol panel_lectura.',
          impacto: 'El cliente ve "la consulta tardó demasiado". Revisar qué pantalla y rango las provocan (Actividad).',
          enlace: null,
        });
      }
      if (e.bd >= 3) {
        out.push({
          clave: 'panel:bd', grupo: 'panel', severidad: 'alta',
          titulo: 'El panel no logra conectarse a la base de datos',
          detalle: `${e.bd} fallos de conexión en la última hora.`,
          impacto: 'El panel no carga. Revisar el contenedor de Postgres y las credenciales de panel_lectura / panel_app.',
          enlace: null,
        });
      }
    },
  },
];

/** Guarda las alertas detectadas: abre las nuevas, actualiza las abiertas y cierra las que ya no ocurren. */
async function persistir(detectadas: AlertaTecnica[], gruposEvaluados: Set<Grupo>) {
  const cli = await poolApp!.connect();
  try {
    await cli.query('BEGIN');
    // Las silenciadas cuyo plazo venció vuelven a estar activas.
    await cli.query(`UPDATE panel.alertas SET estado = 'activa', silenciada_hasta = NULL WHERE estado = 'silenciada' AND silenciada_hasta <= now()`);
    for (const a of detectadas) {
      const upd = await cli.query(
        `UPDATE panel.alertas SET ultima_vez = now(), titulo = $2, detalle = $3, impacto = $4, enlace = $5, severidad = $6
          WHERE clave = $1 AND estado <> 'resuelta'`,
        [a.clave, a.titulo, a.detalle, a.impacto, a.enlace, a.severidad],
      );
      if (!upd.rowCount) {
        await cli.query(
          `INSERT INTO panel.alertas (clave, grupo, severidad, titulo, detalle, impacto, enlace) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [a.clave, a.grupo, a.severidad, a.titulo, a.detalle, a.impacto, a.enlace],
        );
      }
    }
    // Solo se cierran alertas de grupos cuyas reglas corrieron bien (si una regla falló, no se sabe si sigue).
    await cli.query(
      `UPDATE panel.alertas SET estado = 'resuelta', resuelta_at = now(), resuelta_auto = true
        WHERE estado <> 'resuelta' AND grupo = ANY($1::text[]) AND NOT (clave = ANY($2::text[]))`,
      [[...gruposEvaluados], detectadas.map((a) => a.clave)],
    );
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

export async function ejecutarVigilante(): Promise<void> {
  if (corriendo || !poolApp) return;
  corriendo = true;
  const inicio = Date.now();
  const detectadas: AlertaTecnica[] = [];
  const comprobaciones: Comprobacion[] = [];
  const reglas = [...reglasHttp(), ...REGLAS];
  try {
    await Promise.all(
      reglas.map(async (r) => {
        const t = Date.now();
        const propias: AlertaTecnica[] = [];
        try {
          await r.fn(propias);
          detectadas.push(...propias);
          comprobaciones.push({ nombre: r.nombre, grupo: r.grupo, ok: propias.length === 0, ms: Date.now() - t });
        } catch (e) {
          comprobaciones.push({ nombre: r.nombre, grupo: r.grupo, ok: false, ms: Date.now() - t, error: (e as Error).message });
        }
      }),
    );
    // Un grupo cuenta como evaluado si ninguna de sus reglas lanzó error.
    const conError = new Set(comprobaciones.filter((c) => c.error).map((c) => c.grupo));
    const evaluados = new Set(reglas.map((r) => r.grupo).filter((g) => !conError.has(g)));
    await persistir(detectadas, evaluados);
    const ms = Date.now() - inicio;
    const errores = comprobaciones.filter((c) => c.error).map((c) => ({ nombre: c.nombre, error: c.error }));
    await queryApp(`UPDATE panel.vigilante SET ultima_ejecucion = now(), duracion_ms = $1, errores = $2 WHERE id = 1`, [ms, JSON.stringify(errores)]);
    ultima = { at: new Date().toISOString(), ms, comprobaciones: comprobaciones.sort((a, b) => a.grupo.localeCompare(b.grupo)), detectadas: detectadas.length };
  } catch (e) {
    console.error('Vigilante: no se pudo completar la revisión:', (e as Error).message);
  } finally {
    corriendo = false;
  }
}

/** Limpieza diaria: actividad y alertas resueltas de más de 180 días. */
async function limpiar() {
  try {
    await queryApp(`DELETE FROM panel.actividad WHERE at < now() - interval '180 days'`);
    await queryApp(`DELETE FROM panel.alertas WHERE estado = 'resuelta' AND resuelta_at < now() - interval '180 days'`);
    await queryApp(`DELETE FROM panel.alertas_cliente_revisadas WHERE revisada_at < now() - interval '30 days'`);
  } catch (e) {
    console.error('Vigilante: no se pudo limpiar el historial:', (e as Error).message);
  }
}

export function iniciarVigilante(): () => void {
  if (!poolApp || process.env.VIGILANTE === 'off') return () => {};
  const primera = setTimeout(() => void ejecutarVigilante(), 20_000);
  const t = setInterval(() => void ejecutarVigilante(), INTERVALO_MS);
  const l = setInterval(() => void limpiar(), 24 * 60 * 60_000);
  for (const x of [primera, t, l]) x.unref();
  return () => {
    clearTimeout(primera);
    clearInterval(t);
    clearInterval(l);
  };
}
