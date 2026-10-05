import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, leerPagina, leerRango, leerTexto } from '../params.js';
import { PERIODOS, periodo } from '../sql.js';

const FILTROS_RESPUESTA = new Set(['respondio', 'respondio_tarde', 'no_respondio', 'pendiente', 'no_aplica']);
const OK = `estado NOT IN ('rechazado_api', 'failed')`;

export default async function rutasCampanas(app: FastifyInstance) {
  app.get('/api/campanas', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta, r.grano];
    return conCache(claveCache(req), async () => {
      const [porCampana, serie, entregaDesde] = await Promise.all([
        // CAM-01: "confirmó" = respondió "confirmo" al mensaje o la cita pasó a Confirmado después del envío.
        // Antes se usaba solo el historial de estados, que existe desde el 30-sep-2026 y dejaba el histórico en 0.
        query(
          `SELECT campana,
                  count(DISTINCT fecha_bogota) AS dias,
                  count(*) FILTER (WHERE ${OK}) AS enviados,
                  count(*) FILTER (WHERE NOT ${OK}) AS fallidos,
                  count(*) FILTER (WHERE entregado) AS entregados,
                  count(*) FILTER (WHERE leido) AS leidos,
                  count(*) FILTER (WHERE estado_respuesta = 'respondio') AS respondieron,
                  count(*) FILTER (WHERE estado_respuesta = 'respondio_tarde') AS respondieron_tarde,
                  count(*) FILTER (WHERE estado_respuesta = 'no_respondio') AS no_respondieron,
                  count(*) FILTER (WHERE estado_respuesta = 'pendiente') AS pendientes,
                  count(*) FILTER (WHERE respuesta_tipo = 'confirmo' OR cita_confirmada_despues) AS citas_confirmadas,
                  count(*) FILTER (WHERE cita_cancelada_despues) AS citas_canceladas
             FROM bi.fact_envios
            WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'
            GROUP BY campana
            ORDER BY count(*) FILTER (WHERE ${OK}) DESC`,
          p.slice(0, 2),
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo, c.campana, coalesce(c.enviados, 0) AS enviados
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_bogota')} AS periodo, campana, count(*) FILTER (WHERE ${OK}) AS enviados
                 FROM bi.fact_envios
                WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'
                GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          p,
        ),
        // Desde cuándo hay estados de entrega/lectura de Meta (antes solo se sabía si la API aceptó el envío).
        queryOne(`SELECT min(fecha_bogota) AS fecha FROM bi.fact_envios WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL`),
      ]);
      return { rango: r, porCampana, serie, entregaDesde: entregaDesde?.fecha ?? null };
    });
  });

  // CAM-06: % acumulado de envíos respondidos (y leídos) según las horas transcurridas desde el envío.
  app.get('/api/campanas/tiempos', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const [respuesta, lectura] = await Promise.all([
        query(
          `WITH base AS (
             SELECT campana, minutos_a_respuesta AS m
               FROM bi.fact_envios
              WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' AND ${OK}
                AND campana IN ('execute', 'reminder', 'recuperacion', 'conasistencia')
           ), tot AS (SELECT campana, count(*) AS n FROM base GROUP BY 1)
           SELECT b.campana, h.hora, tot.n AS enviados,
                  count(*) FILTER (WHERE b.m IS NOT NULL AND b.m <= h.hora * 60) AS acumulado
             FROM base b
             JOIN tot USING (campana)
            CROSS JOIN (VALUES (1), (2), (4), (6), (12), (24), (48), (72)) AS h(hora)
            GROUP BY 1, 2, 3 ORDER BY 1, 2`,
          [r.desde, r.hasta],
        ),
        queryOne(
          `SELECT count(*) FILTER (WHERE read_at IS NOT NULL) AS leidos,
                  count(*) FILTER (WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL) AS entregados,
                  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos_a_lectura))::numeric, 0) AS mediana_lectura_min,
                  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos_a_respuesta))::numeric, 0) AS mediana_respuesta_min
             FROM bi.fact_envios
            WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' AND ${OK}`,
          [r.desde, r.hasta],
        ),
      ]);
      return { respuesta, lectura };
    });
  });

  // CAM-08: errores de entrega del período y calidad de los teléfonos de los pacientes (estado actual).
  app.get('/api/campanas/calidad', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const [errores, telefonos, compartidos] = await Promise.all([
        query(
          `SELECT coalesce(error_code, '') AS codigo, coalesce(error_titulo, 'Sin detalle (rechazado por la API)') AS error,
                  count(*) AS n, min(fecha_bogota) AS desde, max(fecha_bogota) AS hasta
             FROM bi.fact_envios
            WHERE fecha_bogota BETWEEN $1 AND $2 AND NOT ${OK}
            GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
          [r.desde, r.hasta],
        ),
        queryOne(
          `SELECT count(*) AS pacientes,
                  count(*) FILTER (WHERE telefono_norm IS NULL) AS sin_telefono_valido,
                  count(*) FILTER (WHERE telefono_norm IS NOT NULL AND telefono_norm !~ '^573') AS no_movil
             FROM bi.dim_paciente`,
        ),
        queryOne(
          `SELECT count(*) FILTER (WHERE pacientes_asociados > 1) AS numeros,
                  coalesce(sum(pacientes_asociados) FILTER (WHERE pacientes_asociados > 1), 0) AS pacientes
             FROM bi.dim_contacto`,
        ),
      ]);
      return { errores, telefonos, compartidos };
    });
  });

  // Exportación para que recepción corrija teléfonos: pacientes con teléfono inválido o no móvil.
  app.get('/api/campanas/telefonos-invalidos', async () => ({
    filas: await query(
      `SELECT nombre_completo, tipo_documento, numero_documento, numero_contacto, email, created_at_bogota AS registrado,
              CASE WHEN telefono_norm IS NULL THEN 'Inválido' ELSE 'No es celular colombiano' END AS problema
         FROM bi.dim_paciente
        WHERE telefono_norm IS NULL OR telefono_norm !~ '^573'
        ORDER BY created_at DESC NULLS LAST LIMIT 2000`,
    ),
  }));

  app.get('/api/campanas/envios', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const campana = leerTexto(q, 'campana', 60);
    const respuesta = leerTexto(q, 'respuesta', 30);
    if (respuesta && !FILTROS_RESPUESTA.has(respuesta)) throw new ErrorParametro('Filtro de respuesta inválido');
    const { tam, offset } = leerPagina(q, 50, 5000);
    const where = `fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'
                   AND ($3::text IS NULL OR campana = $3) AND ($4::text IS NULL OR estado_respuesta = $4)`;
    const p = [r.desde, r.hasta, campana, respuesta];
    return conCache(claveCache(req), async () => {
      const [filas, total] = await Promise.all([
        query(
          `SELECT aceptado_at_bogota AS enviado, campana, plantilla, nombre_paciente, documento_paciente, telefono_norm,
                  estado, entregado, leido, estado_respuesta, respuesta_tipo, respondido_at_bogota AS respondido,
                  fecha_cita, hora_cita, estado_cita_actual,
                  (respuesta_tipo = 'confirmo' OR cita_confirmada_despues) AS cita_confirmada_despues,
                  cita_cancelada_despues, error_titulo
             FROM bi.fact_envios
            WHERE ${where}
            ORDER BY aceptado_at DESC NULLS LAST
            LIMIT ${tam} OFFSET ${offset}`,
          p,
        ),
        queryOne<{ n: number }>(`SELECT count(*) AS n FROM bi.fact_envios WHERE ${where}`, p),
      ]);
      return { filas, total: total.n };
    });
  });
}
