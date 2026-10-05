import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { ErrorParametro, leerRango, leerTexto } from '../params.js';
import { CITAS } from '../sql.js';
import { contacto, ejecuciones } from '../sql2.js';

const CAMPANAS_EMBUDO = new Set(['reminder', 'execute', 'daily', 'recuperacion', 'conasistencia']);
const OK = `estado NOT IN ('rechazado_api', 'failed')`;

export default async function rutasCampanas2(app: FastifyInstance) {
  // CAM-02: embudo de una campaña: aceptado → entregado → leído → respondió → confirmó → la cita se atendió.
  // "Se atendió": la cita enlazada (por agenda_id o por teléfono + cita en los 6 días siguientes) terminó en Asistio.
  app.get('/api/campanas/embudo', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const campana = leerTexto(q, 'campana', 30) ?? 'reminder';
    if (!CAMPANAS_EMBUDO.has(campana)) throw new ErrorParametro('Campaña inválida');
    return conCache(req.url, async () => {
      const [etapas, seguimiento] = await Promise.all([
        queryOne(
          `WITH e AS (
             SELECT * FROM bi.fact_envios
              WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' AND campana = $3 AND ${OK}
           ),
           -- Envíos cuya cita enlazada se atendió. El embudo cuenta solo los que además confirmaron (cuando la
           -- campaña pide confirmación), para que cada etapa sea parte de la anterior.
           asistio AS (
             SELECT e.envio_id FROM e JOIN bi.fact_citas c ON c.agenda_id = e.agenda_id AND c.estado_agenda = 'Asistio'
             UNION
             SELECT e.envio_id FROM e JOIN bi.fact_citas c
                 ON e.agenda_id IS NULL AND c.telefono_norm = e.telefono_norm
                AND c.fecha_cita BETWEEN e.fecha_bogota AND e.fecha_bogota + 6 AND c.estado_agenda = 'Asistio'
           )
           SELECT count(*) AS aceptados,
                  count(*) FILTER (WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL) AS entregados,
                  count(*) FILTER (WHERE read_at IS NOT NULL) AS leidos,
                  count(*) FILTER (WHERE estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron,
                  count(*) FILTER (WHERE respuesta_tipo = 'confirmo' OR cita_confirmada_despues) AS confirmaron,
                  (SELECT count(*) FROM asistio) AS asistieron,
                  count(*) FILTER (WHERE (respuesta_tipo = 'confirmo' OR cita_confirmada_despues)
                                     AND envio_id IN (SELECT envio_id FROM asistio)) AS confirmaron_y_asistieron
             FROM e`,
          [r.desde, r.hasta, campana],
        ),
        // Los estados de entrega y lectura de WhatsApp existen desde esta fecha.
        queryOne<{ fecha: string | null }>(`SELECT min(fecha_bogota) AS fecha FROM bi.fact_envios WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL`),
      ]);
      return { campana, etapas, seguimientoDesde: seguimiento.fecha };
    });
  });

  // CAM-03 y CAM-04: inasistencia según el contacto por WhatsApp y cobertura de los recordatorios.
  app.get('/api/campanas/contacto', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(req.url, async () => {
      const filas = await query(
        `WITH ${CITAS}, ${contacto('$1', '$2')}
         SELECT grupo_contacto AS clave,
                count(*) AS citas,
                count(*) FILTER (WHERE grupo IN ('Asistió', 'No asistió') AND periodo_confiable) AS cerradas,
                count(*) FILTER (WHERE grupo = 'No asistió' AND periodo_confiable) AS no_asistio,
                count(*) FILTER (WHERE recibio_48h) AS con_48h,
                count(*) FILTER (WHERE recibio_24h) AS con_24h,
                count(*) FILTER (WHERE recibio_2h) AS con_2h
           FROM contacto
          WHERE fecha_cita < (now() AT TIME ZONE 'America/Bogota')::date
          GROUP BY 1`,
        [r.desde, r.hasta],
      );
      return { filas };
    }, 300_000);
  });

  // CAM-05: ¿los mensajes de recuperación y seguimiento traen pacientes de vuelta? Solo envíos con la ventana de
  // 60 días ya cumplida. Los envíos rechazados (incidente abr-jun 2026) son el grupo de comparación: el paciente
  // fue elegido para el mensaje pero no lo recibió.
  app.get('/api/campanas/recuperacion', async (req) =>
    conCache(
      req.url,
      async () => {
        const filas = await query(
          `WITH ${CITAS},
           ag AS MATERIALIZED (
             SELECT telefono_norm AS tel, created_at_bogota AS creada, grupo
               FROM citas WHERE es_cita_paciente AND telefono_norm IS NOT NULL
           ),
           env AS (
             SELECT envio_id, campana, telefono_norm AS tel, aceptado_at_bogota AS enviado,
                    to_char(fecha_bogota, 'YYYY-MM') AS mes, ${OK} AS llego
               FROM bi.fact_envios
              WHERE campana IN ('recuperacion', 'conasistencia') AND telefono_norm IS NOT NULL
                AND aceptado_at_bogota <= (now() AT TIME ZONE 'America/Bogota') - interval '60 days'
           ),
           res AS (
             SELECT env.envio_id, env.campana, env.mes, env.llego,
                    bool_or(ag.creada <= env.enviado + interval '30 days') IS TRUE AS volvio_30d,
                    bool_or(ag.grupo = 'Asistió') IS TRUE AS asistio_60d
               FROM env
               LEFT JOIN ag ON ag.tel = env.tel AND ag.creada BETWEEN env.enviado AND env.enviado + interval '60 days'
              GROUP BY 1, 2, 3, 4
           )
           SELECT campana, mes, llego, count(*) AS envios,
                  count(*) FILTER (WHERE volvio_30d) AS volvieron_30d,
                  count(*) FILTER (WHERE asistio_60d) AS asistieron_60d
             FROM res GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        );
        return { filas };
      },
      600_000,
    ),
  );

  // CAM-07: ejecuciones de campaña por día (calendario). Detecta corridas que procesaron citas sin enviar nada.
  app.get('/api/campanas/ejecuciones', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(req.url, async () => ({
      filas: await query(
        `WITH ${ejecuciones('$1')}
         SELECT fecha, campana, count(*) AS corridas,
                coalesce(sum(procesadas), 0) AS procesadas, coalesce(sum(exitosos), 0) AS exitosos,
                coalesce(sum(errores), 0) AS errores
           FROM ejec WHERE fecha BETWEEN $1 AND $2
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [r.desde, r.hasta],
      ),
    }));
  });
}
