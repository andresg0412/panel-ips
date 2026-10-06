import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query, queryApp, poolApp } from '../db.js';
import { ErrorParametro } from '../params.js';

// Envíos manuales: campaña de invitación a la lista de espera (barrido de las citas que ya existían).
// El panel NO decide a quién se invita ni envía nada por su cuenta: todo pasa por el bot, que es quien envía
// por WhatsApp y aplica la lista piloto, el interruptor, el kill switch y el filtro de crisis. El backend
// calcula la elegibilidad (una sola regla para el cron y para el panel).
//   - Previsualizar: el bot devuelve conteos + los agenda_id elegibles en el orden en que se reservan (sin datos
//     personales); el panel completa paciente, fecha y profesional con su propio acceso de lectura.
//   - Enviar: el bot responde 202 y envía en segundo plano; el avance se lee de ejecuciones_invitacion_lista_espera
//     e invitaciones_lista_espera (SELECT para panel_lectura, ver deploy/crear-rol.sql).
// Plan: proyecto-ips/docs/features/2026-10-04-campanas-invitacion-lista-espera-implementacion.md, sección 13.2.

const BOT_URL = (process.env.PANEL_BOT_URL ?? 'https://chatbotips.zentrixsolucionesdigitales.com').replace(/\/+$/, '');
const RUTA_BOT = '/v1/campaigns/lista-espera-regularizacion';
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Tope de la API del bot (LIMITE_MAXIMO_INVITACION); el backend además aplica LISTA_ESPERA_INVITACION_MAX_POR_EJECUCION. */
const LIMITE_MAXIMO = 300;

interface Previsualizacion {
  fecha_corte: string;
  total_evaluadas: number;
  total_elegibles: number;
  excluidas: Record<string, number>;
  pacientes_varias_citas: number;
  agenda_ids_elegibles?: string[];
  dentro_de_horario_contacto?: boolean;
  horario_contacto?: { inicio: string; fin: string };
  max_por_ejecucion?: number;
}

function leerFecha(v: unknown, nombre: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !FECHA.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ErrorParametro(`${nombre} debe tener el formato AAAA-MM-DD`);
  }
  return v;
}

function leerFechas(q: Record<string, unknown>) {
  const fecha_desde = leerFecha(q.fecha_desde, 'La fecha inicial');
  const fecha_hasta = leerFecha(q.fecha_hasta, 'La fecha final');
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta) throw new ErrorParametro('La fecha inicial es posterior a la final');
  return { fecha_desde, fecha_hasta };
}

class ErrorBot extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** POST al endpoint de la campaña del bot. Devuelve el status y el cuerpo tal cual. */
async function llamarBot(cuerpo: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: Record<string, any> }> {
  let res: Response;
  try {
    res = await fetch(`${BOT_URL}${RUTA_BOT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ErrorBot(`No se pudo contactar al bot de WhatsApp (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'sin conexión'}).`, 502);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

const usuario = (req: FastifyRequest) => req.contexto?.usuario ?? null;

async function registrarEnvio(req: FastifyRequest, fila: { parametros: unknown; elegibles_previstos: number | null; status: number; respuesta: unknown }) {
  if (!poolApp) return;
  try {
    await queryApp(
      `INSERT INTO panel.envios_manuales (usuario, rol, campana, parametros, elegibles_previstos, status, respuesta)
       VALUES ($1, $2, 'invitacion_lista_espera', $3::jsonb, $4, $5, $6::jsonb)`,
      [usuario(req), req.contexto?.rolReal ?? null, JSON.stringify(fila.parametros), fila.elegibles_previstos, fila.status, JSON.stringify(fila.respuesta)],
    );
  } catch (e) {
    req.log.error(e, 'no se pudo registrar el envío manual');
  }
}

export default async function rutasEnvios(app: FastifyInstance) {
  // Previsualizar: a quiénes se enviaría ahora mismo, en el orden en que se enviaría. Sin caché: tiene que ser la
  // foto del momento, porque es lo que la persona confirma antes de enviar.
  app.get('/api/envios/invitacion/previsualizar', async (req, reply) => {
    const { fecha_desde, fecha_hasta } = leerFechas(req.query as Record<string, unknown>);
    let r: { status: number; body: Record<string, any> };
    try {
      r = await llamarBot({ modo_previsualizacion: true, incluir_ids: true, ...(fecha_desde ? { fecha_desde } : {}), ...(fecha_hasta ? { fecha_hasta } : {}) }, 60_000);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    if (r.status !== 200) {
      req.log.warn({ status: r.status, body: r.body }, 'previsualización del bot fallida');
      return reply.code(502).send({ error: 'El bot no pudo calcular la lista en este momento. Intente de nuevo en unos minutos.' });
    }
    const p = r.body as Previsualizacion;
    const ids = Array.isArray(p.agenda_ids_elegibles) ? p.agenda_ids_elegibles.filter((x) => typeof x === 'string') : [];
    const datos = ids.length
      ? await query<Record<string, any>>(
          `SELECT f.agenda_id, f.fecha_cita, to_char(f.hora_cita, 'HH24:MI') AS hora_cita,
                  coalesce(pa.nombre_completo, f.nombre_paciente) AS paciente,
                  coalesce(pa.numero_documento, f.documento_paciente) AS documento_paciente,
                  coalesce(f.telefono_norm, pa.telefono_norm) AS telefono_norm,
                  coalesce(pr.nombre_completo, f.profesional) AS profesional,
                  coalesce(f.especialidad, pr.especialidad) AS especialidad
             FROM bi.fact_citas f
             LEFT JOIN bi.dim_paciente pa ON pa.paciente_id = f.paciente_id
             LEFT JOIN bi.dim_profesional pr ON pr.profesional_id = f.profesional_id
            WHERE f.agenda_id = ANY($1::text[])`,
          [ids],
        )
      : [];
    const porId = new Map(datos.map((d) => [d.agenda_id, d]));
    // Mismo orden que el bot: los primeros N de esta lista son los que se envían con "Enviar a N".
    const filas = ids.map((id, i) => ({ orden: i + 1, ...(porId.get(id) ?? { agenda_id: id }) }));
    const { agenda_ids_elegibles: _ids, ...resumen } = p;
    return {
      resumen: { ...resumen, max_por_ejecucion: Math.min(p.max_por_ejecucion ?? LIMITE_MAXIMO, LIMITE_MAXIMO) },
      filtros: { fecha_desde, fecha_hasta },
      filas,
    };
  });

  // Enviar: arranca la campaña en el bot. Responde enseguida; el envío sigue en segundo plano (~3 s por mensaje).
  app.post(
    '/api/envios/invitacion/ejecutar',
    {
      schema: {
        body: {
          type: 'object',
          required: ['limite'],
          additionalProperties: false,
          properties: {
            limite: { type: 'integer', minimum: 1, maximum: LIMITE_MAXIMO },
            fecha_desde: { type: ['string', 'null'] },
            fecha_hasta: { type: ['string', 'null'] },
            elegibles_previstos: { type: ['integer', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { limite: number; fecha_desde?: string | null; fecha_hasta?: string | null; elegibles_previstos?: number | null };
      const { fecha_desde, fecha_hasta } = leerFechas(b as Record<string, unknown>);
      const parametros = { limite: b.limite, fecha_desde, fecha_hasta };
      const cuerpo = { origen: 'manual', limite: b.limite, ...(fecha_desde ? { fecha_desde } : {}), ...(fecha_hasta ? { fecha_hasta } : {}) };
      let r: { status: number; body: Record<string, any> };
      try {
        r = await llamarBot(cuerpo, 30_000);
      } catch (e) {
        const status = e instanceof ErrorBot ? e.status : 502;
        await registrarEnvio(req, { parametros, elegibles_previstos: b.elegibles_previstos ?? null, status, respuesta: { error: (e as Error).message } });
        return reply.code(status).send({ error: (e as Error).message });
      }
      await registrarEnvio(req, { parametros, elegibles_previstos: b.elegibles_previstos ?? null, status: r.status, respuesta: r.body });

      const estado = r.body?.estado;
      if (r.status === 202 && estado === 'iniciada') {
        return { estado: 'iniciada', limite: r.body.limite ?? b.limite, mensaje: `Envío iniciado: hasta ${r.body.limite ?? b.limite} invitaciones.` };
      }
      if (r.status === 409 || estado === 'en_curso') {
        return reply.code(409).send({ error: 'Ya hay un envío de esta campaña en curso. Espere a que termine.', estado: 'en_curso' });
      }
      if (estado === 'deshabilitada') {
        return reply.code(409).send({ error: 'Las invitaciones están apagadas en el bot (LISTA_ESPERA_INVITACION_ENABLED).', estado });
      }
      if (estado === 'no_iniciada') {
        const motivo = r.body.motivo === 'bot_deshabilitado' ? 'el bot está deshabilitado (kill switch)' : 'falta configurar la plantilla en el bot';
        return reply.code(409).send({ error: `No se inició el envío: ${motivo}.`, estado });
      }
      req.log.warn({ status: r.status, body: r.body }, 'respuesta inesperada del bot al ejecutar la campaña');
      return reply.code(502).send({ error: r.body?.error ? `El bot rechazó el envío: ${r.body.error}` : `El bot respondió ${r.status}.` });
    },
  );

  // Historial y avance: ejecuciones de la regularización (manuales y por cron) con el estado de sus invitaciones, y
  // quién lanzó cada una desde el panel.
  app.get('/api/envios/invitacion/historial', async () => {
    const bog = (col: string) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')`;
    const ejecuciones = await query<Record<string, any>>(
      `SELECT e.ejecucion_id, e.origen, e.estado, e.motivo_fin, e.total_elegibles,
              (e.parametros->>'tope_efectivo')::int AS tope, e.parametros->>'fecha_desde' AS fecha_desde,
              e.parametros->>'fecha_hasta' AS fecha_hasta,
              to_char(${bog('e.iniciada_at')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS iniciada,
              to_char(${bog('e.finalizada_at')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS finalizada,
              to_char(e.iniciada_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iniciada_utc,
              count(i.invitacion_id) AS reservadas,
              count(i.invitacion_id) FILTER (WHERE i.enviada_at IS NOT NULL) AS enviadas,
              count(i.invitacion_id) FILTER (WHERE i.estado = 'error') AS errores,
              count(i.invitacion_id) FILTER (WHERE i.estado = 'pendiente') AS pendientes,
              count(i.invitacion_id) FILTER (WHERE i.estado = 'aceptada') AS aceptadas,
              count(i.invitacion_id) FILTER (WHERE i.estado = 'rechazada') AS rechazadas,
              count(i.invitacion_id) FILTER (WHERE i.estado = 'sin_respuesta') AS sin_respuesta,
              count(i.invitacion_id) FILTER (WHERE i.estado IN ('excluida', 'anulada')) AS descartadas
         FROM ejecuciones_invitacion_lista_espera e
         LEFT JOIN invitaciones_lista_espera i ON i.ejecucion_id = e.ejecucion_id
        WHERE e.campana_tipo = 'regularizacion'
        GROUP BY e.ejecucion_id
        ORDER BY e.iniciada_at DESC
        LIMIT 20`,
    );
    const lanzados = poolApp
      ? await queryApp<{ at: string; usuario: string | null; status: number; parametros: Record<string, unknown> }>(
          `SELECT to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, usuario, status, parametros
             FROM panel.envios_manuales
            WHERE campana = 'invitacion_lista_espera' AND at > now() - interval '120 days'
            ORDER BY at DESC LIMIT 50`,
        ).catch(() => [])
      : [];
    // La ejecución la crea el bot al reservar el primer lote, segundos después del clic: se asocia al envío
    // aceptado (202) más reciente que haya ocurrido hasta 5 minutos antes.
    const aceptados = lanzados.filter((l) => l.status === 202);
    const filas = ejecuciones.map((e) => {
      const t = Date.parse(e.iniciada_utc);
      const quien = e.origen === 'manual' ? aceptados.find((l) => Date.parse(l.at) <= t + 5_000 && t - Date.parse(l.at) < 5 * 60_000) : undefined;
      const { iniciada_utc: _u, ...resto } = e;
      return { ...resto, lanzada_por: quien?.usuario ?? null };
    });
    return { ejecuciones: filas, en_curso: ejecuciones.some((e) => e.estado === 'en_curso') };
  });
}
