import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { HOY } from '../sql.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { leerRango } from '../params.js';

// Tablas de public con SELECT explícito para panel_lectura (ver deploy/crear-rol.sql):
// lista_espera, cupos_liberados, ofertas_cupo, invitaciones_lista_espera, ejecuciones_invitacion_lista_espera.
export default async function rutasListaEspera(app: FastifyInstance) {
  app.get('/api/lista-espera', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    const enRango = (col: string) => `${col} >= $1::date AND ${col} < $2::date + 1`;
    return conCache(claveCache(req), async () => {
      // Las columnas *_at de estas tablas son TIMESTAMP en UTC: se pasan a hora de Bogotá antes de filtrar.
      const bog = (col: string) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')`;
      // Las vistas bi nuevas (migración 042 del backend) pueden faltar: sin ellas esas secciones salen vacías y el resto sigue.
      const opcional = <T,>(promesa: Promise<T>, vacio: T): Promise<T> =>
        promesa.catch((error) => {
          console.error('Lista de espera: sección no disponible:', error?.message ?? error);
          return vacio;
        });
      const [inscripcionesHoy, inscripciones, cupos, ofertas, invitaciones, cuposRecientes, ofertasRecientes, ejecuciones, embudo, motivos, invitacionesPorTipo,
        ahora, pausadas, flujoPeriodo, flujoDiario, respuesta] =
        await Promise.all([
          query(`SELECT estado AS clave, count(*) AS n FROM lista_espera GROUP BY 1 ORDER BY 2 DESC`),
          query(
            `SELECT estado AS clave, count(*) AS n FROM lista_espera WHERE ${enRango(bog('created_at'))} GROUP BY 1 ORDER BY 2 DESC`,
            p,
          ),
          query(
            `SELECT estado AS clave, count(*) AS n FROM cupos_liberados WHERE ${enRango(bog('detectado_at'))} GROUP BY 1 ORDER BY 2 DESC`,
            p,
          ),
          query(
            `SELECT estado AS clave, count(*) AS n FROM ofertas_cupo
              WHERE ${enRango(bog('coalesce(enviada_at, created_at)'))} GROUP BY 1 ORDER BY 2 DESC`,
            p,
          ),
          query(
            `SELECT estado AS clave, count(*) AS n FROM invitaciones_lista_espera
              WHERE ${enRango(bog('created_at'))} GROUP BY 1 ORDER BY 2 DESC`,
            p,
          ),
          query(
            `SELECT ${bog('c.detectado_at')} AS detectado, c.fecha_cita, c.hora_cita, c.estado, c.origen_deteccion,
                    c.motivo_cierre, c.nivel_cascada_origen, pr.nombre_completo AS profesional, pr.especialidad,
                    pa.nombre_completo AS asignado_a, ${bog('c.asignado_at')} AS asignado
               FROM cupos_liberados c
               LEFT JOIN bi.dim_profesional pr ON pr.profesional_id = c.profesional_id
               LEFT JOIN bi.dim_paciente pa ON pa.paciente_id = c.asignado_a_paciente_id
              WHERE ${enRango(bog('c.detectado_at'))}
              ORDER BY c.detectado_at DESC LIMIT 100`,
            p,
          ),
          query(
            `SELECT ${bog('o.enviada_at')} AS enviada, ${bog('o.respondida_at')} AS respondida, o.estado, o.nivel_cascada,
                    o.posicion_en_fila, pa.nombre_completo AS paciente, c.fecha_cita, c.hora_cita, pr.nombre_completo AS profesional
               FROM ofertas_cupo o
               LEFT JOIN bi.dim_paciente pa ON pa.paciente_id = o.paciente_id
               LEFT JOIN cupos_liberados c ON c.cupo_liberado_id = o.cupo_liberado_id
               LEFT JOIN bi.dim_profesional pr ON pr.profesional_id = c.profesional_id
              WHERE ${enRango(bog('coalesce(o.enviada_at, o.created_at)'))}
              ORDER BY coalesce(o.enviada_at, o.created_at) DESC LIMIT 100`,
            p,
          ),
          query(
            `SELECT ${bog('iniciada_at')} AS iniciada, campana_tipo, estado, total_evaluadas, total_elegibles,
                    enviadas, errores, motivo_fin
               FROM ejecuciones_invitacion_lista_espera
              WHERE ${enRango(bog('iniciada_at'))}
              ORDER BY iniciada_at DESC LIMIT 50`,
            p,
          ),
          // LE-01 y LE-02: cupos liberados → con oferta → aceptados → asignados → la cita recolocada se atendió;
          // horas de consulta recuperadas y tiempo hasta recolocar.
          queryOne(
            `WITH cu AS (SELECT * FROM cupos_liberados WHERE ${enRango(bog('detectado_at'))})
             SELECT count(*) AS cupos,
                    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ofertas_cupo o WHERE o.cupo_liberado_id = cu.cupo_liberado_id
                                                     AND o.enviada_at IS NOT NULL)) AS con_oferta,
                    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ofertas_cupo o WHERE o.cupo_liberado_id = cu.cupo_liberado_id
                                                     AND o.estado = 'aceptada')) AS aceptados,
                    count(*) FILTER (WHERE estado = 'asignado') AS asignados,
                    coalesce(round(sum(extract(epoch FROM (hora_final - hora_cita)) / 3600.0)
                                   FILTER (WHERE estado = 'asignado' AND hora_final > hora_cita)::numeric, 1), 0) AS horas_recuperadas,
                    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (asignado_at - detectado_at)) / 60.0)
                           FILTER (WHERE asignado_at IS NOT NULL))::numeric, 0) AS minutos_hasta_asignar,
                    (SELECT count(*) FROM bi.fact_citas f
                      WHERE f.movida_desde_cita_id IS NOT NULL AND f.estado_agenda = 'Asistio'
                        AND f.fecha_cita BETWEEN $1 AND $2) AS recolocadas_atendidas
               FROM cu`,
            p,
          ),
          // LE-03: por qué no se recoloca un cupo.
          query(
            `SELECT coalesce(motivo_cierre, estado) AS clave, count(*) AS n
               FROM cupos_liberados
              WHERE ${enRango(bog('detectado_at'))} AND estado <> 'asignado'
              GROUP BY 1 ORDER BY 2 DESC`,
            p,
          ),
          // LE-04: invitaciones por tipo de campaña y estado.
          query(
            `SELECT campana_tipo, estado AS clave, count(*) AS n
               FROM invitaciones_lista_espera
              WHERE ${enRango(bog('created_at'))}
              GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
            p,
          ),
          // D11: "En lista de espera ahora". Una inscripción cuenta como elegible si su cita sigue Pendiente/Confirmado
          // y es futura (la misma regla de la cascada); las demás activas quedan en "sin cita elegible".
          queryOne(
            `WITH i AS (
               SELECT l.lista_espera_id, l.estado,
                      (f.estado_agenda IN ('Pendiente', 'Confirmado') AND f.fecha_cita >= ${HOY}) AS elegible,
                      EXISTS (SELECT 1 FROM ofertas_cupo o WHERE o.lista_espera_id = l.lista_espera_id AND o.estado = 'enviada') AS con_oferta
                 FROM lista_espera l LEFT JOIN bi.fact_citas f ON f.agenda_id = l.cita_actual_id
                WHERE l.estado IN ('activa', 'pausada'))
             SELECT count(*) FILTER (WHERE estado = 'activa') AS activas,
                    count(*) FILTER (WHERE estado = 'activa' AND elegible AND con_oferta) AS con_oferta_en_curso,
                    count(*) FILTER (WHERE estado = 'activa' AND elegible AND NOT con_oferta) AS esperando_cupo,
                    count(*) FILTER (WHERE estado = 'activa' AND coalesce(NOT elegible, true)) AS sin_cita_elegible,
                    count(*) FILTER (WHERE estado = 'pausada') AS pausadas,
                    (SELECT count(*) FROM cupos_liberados WHERE estado = 'en_oferta' AND reintentar_desde IS NOT NULL) AS cupos_en_espera
               FROM i`,
          ),
          query(
            `SELECT coalesce(motivo_pausa, 'sin_dato') AS clave, count(*) AS n FROM lista_espera WHERE estado = 'pausada' GROUP BY 1 ORDER BY 2 DESC`,
          ),
          // Flujo del período: quiénes consiguieron cupo, salieron de la lista o se reactivaron solos (D5).
          opcional(
            query(
              `SELECT CASE
                        WHEN tipo_evento = 'oferta_aceptada' THEN 'consiguieron_cupo'
                        WHEN tipo_evento IN ('inscripcion_retirada_paciente', 'inscripcion_retirada_reprogramacion_externa') THEN 'salieron'
                        WHEN tipo_evento = 'inscripcion_reactivada' THEN 'reactivadas'
                        WHEN tipo_evento = 'inscripcion_creada' THEN 'inscritos'
                      END AS clave,
                      count(DISTINCT lista_espera_id) AS n
                 FROM bi.v_eventos_lista_espera
                WHERE fecha_bogota BETWEEN $1 AND $2
                  AND tipo_evento IN ('oferta_aceptada', 'inscripcion_retirada_paciente', 'inscripcion_retirada_reprogramacion_externa',
                                      'inscripcion_reactivada', 'inscripcion_creada')
                GROUP BY 1`,
              p,
            ),
            [],
          ),
          opcional(
            query(
              `SELECT fecha_bogota::text AS dia,
                      CASE
                        WHEN tipo_evento = 'oferta_aceptada' THEN 'consiguieron_cupo'
                        WHEN tipo_evento IN ('inscripcion_retirada_paciente', 'inscripcion_retirada_reprogramacion_externa') THEN 'salieron'
                        WHEN tipo_evento = 'inscripcion_reactivada' THEN 'reactivadas'
                        WHEN tipo_evento = 'inscripcion_creada' THEN 'inscritos'
                      END AS clave,
                      count(DISTINCT lista_espera_id) AS n
                 FROM bi.v_eventos_lista_espera
                WHERE fecha_bogota BETWEEN $1 AND $2
                  AND tipo_evento IN ('oferta_aceptada', 'inscripcion_retirada_paciente', 'inscripcion_retirada_reprogramacion_externa',
                                      'inscripcion_reactivada', 'inscripcion_creada')
                GROUP BY 1, 2 ORDER BY 1`,
              p,
            ),
            [],
          ),
          // M6: respuesta real a las ofertas. Toque = el paciente tocó un botón (intención de aceptar o respuesta).
          // Aceptación perdida por plazo = tocó "Sí" pero la oferta ya había vencido. Minutos hasta leer: cruce con
          // bi.fact_envios por el id del mensaje de WhatsApp.
          queryOne(
            `WITH o AS (
               SELECT o.*, (SELECT min(e.minutos_a_lectura) FROM bi.fact_envios e WHERE e.wa_message_id = o.mensaje_wa_id) AS min_lectura
                 FROM ofertas_cupo o
                WHERE o.enviada_at IS NOT NULL AND ${enRango(bog('o.enviada_at'))})
             SELECT count(*) AS ofertas,
                    count(*) FILTER (WHERE respondida_at IS NOT NULL OR intencion_aceptar_at IS NOT NULL) AS con_toque,
                    count(*) FILTER (WHERE estado = 'expirada' AND intencion_aceptar_at IS NOT NULL) AS aceptaciones_perdidas,
                    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY min_lectura) FILTER (WHERE min_lectura IS NOT NULL))::numeric, 1) AS minutos_a_leer,
                    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (respondida_at - enviada_at)) / 60.0)
                           FILTER (WHERE respondida_at IS NOT NULL AND respondida_at >= enviada_at))::numeric, 1) AS minutos_a_responder
               FROM o`,
            p,
          ),
        ]);
      return {
        rango: r, inscripcionesHoy, inscripciones, cupos, ofertas, invitaciones, cuposRecientes, ofertasRecientes, ejecuciones, embudo, motivos,
        invitacionesPorTipo, ahora, pausadas, flujoPeriodo, flujoDiario, respuesta,
      };
    });
  });
}
