import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { conCache } from '../cache.js';
import { leerRango } from '../params.js';

// Tablas de public con SELECT explícito para panel_lectura (ver deploy/crear-rol.sql):
// lista_espera, cupos_liberados, ofertas_cupo, invitaciones_lista_espera, ejecuciones_invitacion_lista_espera.
export default async function rutasListaEspera(app: FastifyInstance) {
  app.get('/api/lista-espera', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    const enRango = (col: string) => `${col} >= $1::date AND ${col} < $2::date + 1`;
    return conCache(req.url, async () => {
      // Las columnas *_at de estas tablas son TIMESTAMP en UTC: se pasan a hora de Bogotá antes de filtrar.
      const bog = (col: string) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')`;
      const [inscripcionesHoy, inscripciones, cupos, ofertas, invitaciones, cuposRecientes, ofertasRecientes, ejecuciones] =
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
        ]);
      return { rango: r, inscripcionesHoy, inscripciones, cupos, ofertas, invitaciones, cuposRecientes, ofertasRecientes, ejecuciones };
    });
  });
}
