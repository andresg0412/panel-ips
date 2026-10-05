// Etapa 6: inteligencia del plan Full. Predicción de inasistencia, pacientes que se alejan y anomalías.
// Plan: proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md, Etapa 6.
import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { conCache } from '../cache.js';
import { hoyBogota, sumarDias } from '../params.js';
import { incidentes } from '../incidentes.js';
import { CITAS } from '../sql.js';
import { CICLO } from '../sql2.js';
import { citasEnRiesgo, factores } from '../prediccion.js';

// ------------------------------------------------------------------------------------------ anomalías
interface Serie {
  clave: string;
  nombre: string;
  /** Áreas de incidente que invalidan el dato de ese día. */
  areas: string[];
  /** Si subir es malo (cancelaciones, inasistencias). */
  subirEsMalo: boolean;
}

const SERIES: Serie[] = [
  { clave: 'registradas', nombre: 'citas nuevas registradas', areas: ['agenda'], subirEsMalo: false },
  { clave: 'no_ocurrieron', nombre: 'citas canceladas o reprogramadas', areas: ['agenda'], subirEsMalo: true },
  { clave: 'inasistencias', nombre: 'inasistencias', areas: ['agenda'], subirEsMalo: true },
  { clave: 'conversaciones', nombre: 'conversaciones con el bot', areas: ['conversaciones', 'eventos'], subirEsMalo: false },
  { clave: 'envios', nombre: 'mensajes de campaña enviados', areas: ['whatsapp', 'trazabilidad'], subirEsMalo: false },
];

const DIAS_SEMANA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export interface Anomalia {
  clave: string;
  serie: string;
  fecha: string;
  valor: number;
  normal: number;
  z: number;
  tono: 'positivo' | 'negativo' | 'neutro';
  texto: string;
}

const mediana = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Días de las últimas 2 semanas que se salen de lo normal: cada valor se compara con el mismo día de la semana en las
 * 8 semanas anteriores (mediana y desviación absoluta mediana, robustas a días raros). Se ignoran domingos, días con
 * incidente de datos y desvíos pequeños en números bajos.
 */
export function anomalias(): Promise<Anomalia[]> {
  return conCache(
    'anomalias',
    async () => {
      const hoy = hoyBogota();
      const desde = sumarDias(hoy, -14 - 56);
      const filas = await query<{ fecha: string; dow: number } & Record<string, number>>(
        `WITH ${CITAS},
         d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS fecha),
         reg AS (SELECT created_at_bogota::date AS fecha, count(*) AS n FROM citas
                  WHERE es_cita_paciente AND created_at_bogota >= $1::date GROUP BY 1),
         cit AS (SELECT fecha_cita AS fecha,
                        count(*) FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada')) AS no_oc,
                        count(*) FILTER (WHERE grupo = 'No asistió') AS na
                   FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2 GROUP BY 1),
         ses AS (SELECT fecha_bogota AS fecha, count(*) AS n FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1),
         env AS (SELECT fecha_bogota AS fecha, count(*) AS n FROM bi.fact_envios
                  WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' AND estado NOT IN ('rechazado_api', 'failed') GROUP BY 1)
         SELECT d.fecha::text AS fecha, extract(isodow FROM d.fecha)::int AS dow,
                coalesce(reg.n, 0) AS registradas, coalesce(cit.no_oc, 0) AS no_ocurrieron, coalesce(cit.na, 0) AS inasistencias,
                coalesce(ses.n, 0) AS conversaciones, coalesce(env.n, 0) AS envios
           FROM d LEFT JOIN reg USING (fecha) LEFT JOIN cit USING (fecha) LEFT JOIN ses USING (fecha) LEFT JOIN env USING (fecha)
          ORDER BY 1`,
        [desde, sumarDias(hoy, -1)],
      );
      const inc = incidentes();
      const enIncidente = (fecha: string, areas: string[]) =>
        inc.some((i) => (i.area === 'general' || areas.includes(i.area)) && fecha >= i.desde && fecha <= i.hasta);
      const out: Anomalia[] = [];
      const inicioRevision = sumarDias(hoy, -14);
      for (const s of SERIES) {
        for (const f of filas) {
          if (f.fecha < inicioRevision || f.dow === 7 || enIncidente(f.fecha, s.areas)) continue;
          const base = filas
            .filter((x) => x.dow === f.dow && x.fecha < f.fecha && x.fecha >= sumarDias(f.fecha, -56) && !enIncidente(x.fecha, s.areas))
            .map((x) => Number(x[s.clave]));
          if (base.length < 4) continue;
          const med = mediana(base);
          const mad = mediana(base.map((v) => Math.abs(v - med)));
          const escala = mad > 0 ? mad / 0.6745 : base.reduce((a, v) => a + Math.abs(v - med), 0) / base.length || 1;
          const valor = Number(f[s.clave]);
          const z = (valor - med) / escala;
          if (Math.abs(z) < 3.5 || Math.abs(valor - med) < Math.max(5, 0.4 * med)) continue;
          const sube = valor > med;
          const nombreDia = DIAS_SEMANA[f.dow];
          out.push({
            clave: `${s.clave}:${f.fecha}`,
            serie: s.clave,
            fecha: f.fecha,
            valor,
            normal: med,
            z,
            tono: sube === s.subirEsMalo ? 'negativo' : 'positivo',
            texto: `El ${nombreDia} ${f.fecha.slice(8, 10)}/${f.fecha.slice(5, 7)} hubo **${valor} ${s.nombre}**; lo normal un ${nombreDia} es unas ${Math.round(med)}.`,
          });
        }
      }
      return out.sort((a, b) => b.fecha.localeCompare(a.fecha) || Math.abs(b.z) - Math.abs(a.z));
    },
    30 * 60_000,
  );
}

const ENLACE_SERIE: Record<string, string> = {
  registradas: '#/agenda',
  no_ocurrieron: '#/capacidad?t=cancelaciones',
  inasistencias: '#/capacidad?t=inasistencia',
  conversaciones: '#/chatbot?t=conversaciones',
  envios: '#/campanas?t=ejecuciones',
};
export const enlaceAnomalia = (a: Anomalia) => ENLACE_SERIE[a.serie] ?? '#/inteligencia?t=anomalias';

// ----------------------------------------------------------------------------------------------- rutas
export default async function rutasInteligencia(app: FastifyInstance) {
  // Predicción de inasistencia de las citas de hoy y los dos días siguientes.
  app.get('/api/inteligencia/prediccion', async () =>
    conCache(
      'prediccion',
      async () => {
        const { entrenado, citas } = await citasEnRiesgo(2);
        const dias = [...new Set(citas.map((c) => c.fecha))].sort();
        return {
          validacion: entrenado.validacion,
          entrenadoCon: entrenado.entrenadoCon,
          entrenadoAt: entrenado.entrenadoAt,
          factores: factores(entrenado.modelo).filter((f) => f.efecto >= 1.05).slice(0, 8),
          dias: dias.map((d) => ({
            fecha: d,
            citas: citas.filter((c) => c.fecha === d).length,
            alto: citas.filter((c) => c.fecha === d && c.nivel === 'alto').length,
            medio: citas.filter((c) => c.fecha === d && c.nivel === 'medio').length,
          })),
          lista: citas
            .filter((c) => c.nivel !== 'bajo')
            .sort((a, b) => a.fecha.localeCompare(b.fecha) || (b.nivel === 'alto' ? 1 : 0) - (a.nivel === 'alto' ? 1 : 0) || b.probabilidad - a.probabilidad),
        };
      },
      30 * 60_000,
    ),
  );

  // Pacientes que se están alejando (sobre PAC-04): en riesgo, priorizados por cuánto venían.
  app.get('/api/inteligencia/abandono', async () =>
    conCache(
      'abandono',
      async () => {
        const [estados, lista] = await Promise.all([
          query<{ estado: string; n: number }>(`WITH ${CITAS}, ${CICLO} SELECT estado, count(*) AS n FROM ciclo GROUP BY 1`),
          query(
            `WITH ${CITAS}, ${CICLO}
             SELECT d.nombre_completo AS paciente, ciclo.especialidad, ciclo.profesional, ciclo.ultima, ciclo.dias_sin_venir,
                    round(ciclo.frecuencia::numeric, 0) AS frecuencia, ciclo.atenciones
               FROM ciclo JOIN bi.dim_paciente d USING (paciente_id)
              WHERE ciclo.estado = 'en_riesgo'
              ORDER BY ciclo.atenciones DESC, ciclo.dias_sin_venir LIMIT 100`,
          ),
        ]);
        return { estados, lista };
      },
      30 * 60_000,
    ),
  );

  app.get('/api/inteligencia/anomalias', async () => {
    const lista = await anomalias();
    return { anomalias: lista.map((a) => ({ ...a, enlace: enlaceAnomalia(a) })) };
  });
}
