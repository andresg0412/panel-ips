// Etapa 4: centro de capacidad de la agenda y "Mi agenda" del profesional.
// Plan: proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md, Etapa 4.
import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { hoyBogota, leerRango, leerTexto, sumarDias } from '../params.js';
import { CITAS, HOY, PERIODOS, periodo } from '../sql.js';
import { CAPACIDAD_DESDE, capacidad, slots } from '../sql2.js';
import { normalizar } from './sala.js';

/** Hasta ayer: la ocupación y la capacidad sin usar se miden en días ya pasados. */
const hastaAyer = (hasta: string) => {
  const ayer = sumarDias(hoyBogota(), -1);
  return hasta < ayer ? hasta : ayer;
};

/** Agrupa por especialidad unificando variantes de escritura ("Psicologia Clinica" / "Psicología Clínica"). */
function porEspecialidad<T extends { especialidad: string | null }>(filas: T[], sumar: (keyof T)[]) {
  const grupos = new Map<string, { nombres: Map<string, number>; valores: Record<string, number> }>();
  for (const f of filas) {
    const nombre = f.especialidad?.trim() || 'Sin especialidad';
    const k = normalizar(nombre);
    const g = grupos.get(k) ?? { nombres: new Map<string, number>(), valores: {} as Record<string, number> };
    g.nombres.set(nombre, (g.nombres.get(nombre) ?? 0) + 1);
    for (const c of sumar) g.valores[c as string] = (g.valores[c as string] ?? 0) + Number(f[c] ?? 0);
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => {
    // Nombre visible: la variante con tildes si existe; si no, la más frecuente.
    const nombre = [...g.nombres.entries()].sort((a, b) => Number(/[^\x00-\x7f]/.test(b[0])) - Number(/[^\x00-\x7f]/.test(a[0])) || b[1] - a[1])[0][0];
    return { especialidad: nombre, ...g.valores };
  });
}

export default async function rutasCapacidad(app: FastifyInstance) {
  // Centro de capacidad (Full): cupos ofrecidos y ocupados por especialidad y profesional, capacidad sin usar por
  // día y hora (días ya pasados del período) y, hacia adelante, la primera hora libre de cada profesional.
  app.get('/api/capacidad', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const hasta = hastaAyer(r.hasta);
      const desde = r.desde > CAPACIDAD_DESDE ? r.desde : CAPACIDAD_DESDE;
      const medible = hasta >= desde;
      const hoy = hoyBogota();
      const [profesionales, franjas, futuro] = await Promise.all([
        medible
          ? query<{ profesional: string; especialidad: string | null; cupos: number; ocupan: number; libres: number; liberadas: number; administrativas: number }>(
              `WITH ${CITAS}, ${capacidad('$1', '$2')}
               SELECT profesional, especialidad, sum(cupos) AS cupos, sum(ocupan) AS ocupan, sum(libres) AS libres,
                      sum(liberadas) AS liberadas, sum(administrativas) AS administrativas
                 FROM capacidad GROUP BY 1, 2 ORDER BY 1`,
              [desde, hasta],
            )
          : Promise.resolve([]),
        medible
          ? query<{ dia: number; hora: number; ofrecidos: number; libres: number }>(
              `WITH ${CITAS}, ${slots('$1', '$2')}
               SELECT dia, extract(hour FROM hora)::int AS hora, count(*) AS ofrecidos, count(*) FILTER (WHERE NOT ocupado) AS libres
                 FROM slots GROUP BY 1, 2`,
              [desde, hasta],
            )
          : Promise.resolve([]),
        // Próximos 30 días: primera hora libre (desde ahora) y cupos libres a 7 y 14 días, por profesional.
        query<{ profesional: string; especialidad: string | null; primera: string | null; libres_7d: number; libres_14d: number; cupos_14d: number }>(
          `WITH ${CITAS}, ${slots('$1', '$2')}
           SELECT profesional, especialidad,
                  to_char(min(fecha + hora) FILTER (
                    WHERE NOT ocupado AND (fecha > ${HOY} OR hora > (now() AT TIME ZONE 'America/Bogota')::time)), 'YYYY-MM-DD"T"HH24:MI') AS primera,
                  count(*) FILTER (WHERE NOT ocupado AND fecha <= ${HOY} + 6) AS libres_7d,
                  count(*) FILTER (WHERE NOT ocupado AND fecha <= ${HOY} + 13) AS libres_14d,
                  count(*) FILTER (WHERE fecha <= ${HOY} + 13) AS cupos_14d
             FROM slots
            WHERE fecha > ${HOY} OR hora > (now() AT TIME ZONE 'America/Bogota')::time
            GROUP BY 1, 2 ORDER BY 1`,
          [hoy, sumarDias(hoy, 29)],
        ),
      ]);
      // Días de espera por especialidad: hasta la primera hora libre de cualquiera de sus profesionales.
      const espera = new Map<string, { nombres: Map<string, number>; primera: string | null; libres_7d: number; libres_14d: number; cupos_14d: number; profesionales: number }>();
      for (const f of futuro) {
        const nombre = f.especialidad?.trim() || 'Sin especialidad';
        const k = normalizar(nombre);
        const e = espera.get(k) ?? { nombres: new Map(), primera: null, libres_7d: 0, libres_14d: 0, cupos_14d: 0, profesionales: 0 };
        e.nombres.set(nombre, (e.nombres.get(nombre) ?? 0) + 1);
        if (f.primera && (!e.primera || f.primera < e.primera)) e.primera = f.primera;
        e.libres_7d += f.libres_7d;
        e.libres_14d += f.libres_14d;
        e.cupos_14d += f.cupos_14d;
        e.profesionales++;
        espera.set(k, e);
      }
      const dias = (p: string | null) => (p ? Math.round((Date.parse(`${p.slice(0, 10)}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000) : null);
      return {
        desde,
        hasta,
        hoy,
        medible,
        capacidadDesde: CAPACIDAD_DESDE,
        profesionales,
        especialidades: porEspecialidad(profesionales, ['cupos', 'ocupan', 'libres', 'liberadas', 'administrativas']),
        franjas,
        futuro: futuro.map((f) => ({ ...f, dias: dias(f.primera) })),
        espera: [...espera.values()].map((e) => {
          const nombre = [...e.nombres.entries()].sort((a, b) => Number(/[^\x00-\x7f]/.test(b[0])) - Number(/[^\x00-\x7f]/.test(a[0])) || b[1] - a[1])[0][0];
          return { especialidad: nombre, primera: e.primera, dias: dias(e.primera), libres_7d: e.libres_7d, libres_14d: e.libres_14d, cupos_14d: e.cupos_14d, profesionales: e.profesionales };
        }),
      };
    }, 300_000);
  });

  // Citas recuperables (LE-05, Full): por profesional, los cupos que se liberaron en los últimos 30 días, los que la
  // lista de espera recolocó, los inscritos activos y los cupos libres de los próximos 14 días.
  app.get('/api/capacidad/recuperables', async (req) =>
    conCache(claveCache(req), async () => {
      const hoy = hoyBogota();
      const [liberados, inscritos, recolocados, libres] = await Promise.all([
        query<{ profesional_id: string | null; profesional: string; especialidad: string | null; liberados: number; horas: number }>(
          `WITH ${CITAS}
           SELECT profesional_id, max(profesional_nombre) AS profesional, max(especialidad) AS especialidad, count(*) AS liberados,
                  coalesce(round(sum(extract(epoch FROM (hora_final - hora_cita)) / 3600.0) FILTER (WHERE hora_final > hora_cita)::numeric, 1), 0) AS horas
             FROM citas
            WHERE es_cita_paciente AND grupo IN ('Cancelada', 'Reprogramada') AND fecha_cita BETWEEN ${HOY} - 30 AND ${HOY} - 1
            GROUP BY 1`,
        ),
        query<{ profesional_id: string | null; inscritos: number }>(`SELECT profesional_id, count(*) AS inscritos FROM lista_espera WHERE estado = 'activa' GROUP BY 1`),
        query<{ profesional_id: string | null; recolocados: number }>(
          `SELECT profesional_id, count(*) AS recolocados FROM cupos_liberados
            WHERE estado = 'asignado' AND asignado_at >= (now() AT TIME ZONE 'UTC') - interval '30 days' GROUP BY 1`,
        ),
        // Mismo cálculo que la espera del centro de capacidad: cupos del horario sin cita, desde ahora.
        query<{ profesional_id: string; libres: number }>(
          `WITH ${CITAS}, ${slots('$1', '$2')}
           SELECT profesional_id, count(*) FILTER (WHERE NOT ocupado) AS libres FROM slots
            WHERE fecha > ${HOY} OR hora > (now() AT TIME ZONE 'America/Bogota')::time GROUP BY 1`,
          [hoy, sumarDias(hoy, 13)],
        ),
      ]);
      const nombres = await query<{ profesional_id: string; nombre: string; especialidad: string | null }>(
        `SELECT profesional_id, regexp_replace(trim(nombre_completo), '\\s+', ' ', 'g') AS nombre, especialidad FROM bi.dim_profesional`,
      );
      const porId = new Map<string, { profesional: string; especialidad: string | null; liberados: number; horas: number; inscritos: number; recolocados: number; libres_14d: number }>();
      const fila = (id: string | null, nombre?: string, esp?: string | null) => {
        const k = id ?? '—';
        if (!porId.has(k)) {
          const n = nombres.find((x) => x.profesional_id === id);
          porId.set(k, {
            profesional: n?.nombre ?? nombre ?? (id ? id : 'Sin profesional asignado'),
            especialidad: n?.especialidad ?? esp ?? null,
            liberados: 0,
            horas: 0,
            inscritos: 0,
            recolocados: 0,
            libres_14d: 0,
          });
        }
        return porId.get(k)!;
      };
      // Las citas sin identificador de profesional (psiquiatría y neuropsicología, hallazgo D4) se agrupan por nombre.
      const sinId = new Map<string, { profesional: string; especialidad: string | null; liberados: number; horas: number; inscritos: number; recolocados: number; libres_14d: number }>();
      for (const l of liberados) {
        if (l.profesional_id) {
          const f = fila(l.profesional_id, l.profesional, l.especialidad);
          f.liberados += l.liberados;
          f.horas += Number(l.horas);
        } else if (l.profesional) {
          sinId.set(l.profesional, { profesional: l.profesional, especialidad: l.especialidad, liberados: l.liberados, horas: Number(l.horas), inscritos: 0, recolocados: 0, libres_14d: 0 });
        }
      }
      for (const i of inscritos) fila(i.profesional_id).inscritos += i.inscritos;
      for (const x of recolocados) fila(x.profesional_id).recolocados += x.recolocados;
      for (const x of libres) fila(x.profesional_id).libres_14d += x.libres;
      const filas = [...porId.values(), ...sinId.values()]
        .filter((f) => f.liberados || f.inscritos || f.recolocados || f.libres_14d)
        .sort((a, b) => b.liberados - a.liberados || a.profesional.localeCompare(b.profesional));
      return { filas };
    }, 300_000),
  );

  // Cupos que se liberan por cancelaciones y reprogramaciones (Intermedio).
  app.get('/api/capacidad/cancelaciones', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const HORAS = `coalesce(round(sum(extract(epoch FROM (hora_final - hora_cita)) / 3600.0)
                       FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada') AND hora_final > hora_cita)::numeric, 1), 0)`;
      const [kpis, profesionales, especialidades, serie, recolocados] = await Promise.all([
        queryOne<{ total: number; canceladas: number; reprogramadas: number; horas: number }>(
          `WITH ${CITAS}
           SELECT count(*) AS total, count(*) FILTER (WHERE grupo = 'Cancelada') AS canceladas,
                  count(*) FILTER (WHERE grupo = 'Reprogramada') AS reprogramadas, ${HORAS} AS horas
             FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2`,
          [r.desde, r.hasta],
        ),
        query(
          `WITH ${CITAS}
           SELECT profesional_nombre AS profesional, max(especialidad) AS especialidad, count(*) AS total,
                  count(*) FILTER (WHERE grupo = 'Cancelada') AS canceladas,
                  count(*) FILTER (WHERE grupo = 'Reprogramada') AS reprogramadas, ${HORAS} AS horas
             FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2 AND profesional_nombre <> ''
            GROUP BY 1 ORDER BY count(*) FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada')) DESC`,
          [r.desde, r.hasta],
        ),
        query<{ especialidad: string | null; total: number; canceladas: number; reprogramadas: number }>(
          `WITH ${CITAS}
           SELECT especialidad, count(*) AS total, count(*) FILTER (WHERE grupo = 'Cancelada') AS canceladas,
                  count(*) FILTER (WHERE grupo = 'Reprogramada') AS reprogramadas
             FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2 GROUP BY 1`,
          [r.desde, r.hasta],
        ),
        query(
          `WITH ${CITAS}, p AS (${PERIODOS})
           SELECT p.periodo,
                  count(c.*) FILTER (WHERE c.grupo = 'Cancelada') AS canceladas,
                  count(c.*) FILTER (WHERE c.grupo = 'Reprogramada') AS reprogramadas
             FROM p LEFT JOIN citas c ON c.es_cita_paciente AND ${periodo('c.fecha_cita')} = p.periodo AND c.fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          [r.desde, r.hasta, r.grano],
        ),
        queryOne<{ n: number }>(
          `SELECT count(*) AS n FROM cupos_liberados WHERE estado = 'asignado' AND fecha_cita BETWEEN $1 AND $2`,
          [r.desde, r.hasta],
        ),
      ]);
      return {
        rango: r,
        kpis,
        recolocados: recolocados.n,
        profesionales,
        especialidades: porEspecialidad(especialidades, ['total', 'canceladas', 'reprogramadas']),
        serie,
      };
    });
  });

  // Presencial frente a virtual (Intermedio): volumen, asistencia y cancelación por modalidad.
  app.get('/api/capacidad/modalidad', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const [modalidades, especialidades, serie] = await Promise.all([
        query(
          `WITH ${CITAS}
           SELECT modalidad, count(*) AS total,
                  count(*) FILTER (WHERE grupo = 'Asistió') AS asistio,
                  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio,
                  count(*) FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron,
                  count(*) FILTER (WHERE grupo = 'Programada') AS programadas
             FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2 GROUP BY 1`,
          [r.desde, r.hasta],
        ),
        query<{ especialidad: string | null; presencial: number; virtual: number }>(
          `WITH ${CITAS}
           SELECT especialidad, count(*) FILTER (WHERE modalidad = 'presencial') AS presencial,
                  count(*) FILTER (WHERE modalidad = 'virtual') AS virtual
             FROM citas WHERE es_cita_paciente AND grupo = 'Asistió' AND fecha_cita BETWEEN $1 AND $2 GROUP BY 1`,
          [r.desde, r.hasta],
        ),
        query(
          `WITH ${CITAS}, p AS (${PERIODOS})
           SELECT p.periodo,
                  count(c.*) FILTER (WHERE c.modalidad = 'presencial') AS presencial,
                  count(c.*) FILTER (WHERE c.modalidad = 'virtual') AS virtual
             FROM p LEFT JOIN citas c ON c.es_cita_paciente AND c.grupo = 'Asistió'
                                     AND ${periodo('c.fecha_cita')} = p.periodo AND c.fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          [r.desde, r.hasta, r.grano],
        ),
      ]);
      return { rango: r, modalidades, especialidades: porEspecialidad(especialidades, ['presencial', 'virtual']), serie };
    });
  });

  // "Mi agenda" (PRO-05): los datos del profesional vinculado al usuario en la consola de soporte. El nombre nunca
  // viene del navegador, salvo para el rol soporte, que puede ver la agenda de cualquier profesional.
  app.get('/api/mi-agenda', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const ctx = req.contexto!;
    const nombre = ctx.rolReal === 'soporte' && !ctx.vistaPrevia ? leerTexto(q, 'profesional', 120) : ctx.profesional;
    if (!nombre) return { vinculado: false, nombre: null };
    return conCache(`${claveCache(req)}|${nombre}`, async () => {
      const hoy = hoyBogota();
      const [kpis, proximas, faltan, mensual, ocupacion, libres] = await Promise.all([
        queryOne(
          `WITH ${CITAS}
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE grupo = 'Asistió') AS asistio,
                  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio,
                  count(*) FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron,
                  count(*) FILTER (WHERE grupo = 'Sin cierre') AS sin_cierre,
                  count(DISTINCT paciente_id) FILTER (WHERE grupo = 'Asistió') AS pacientes
             FROM citas WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2`,
          [r.desde, r.hasta, nombre],
        ),
        // Próximas dos semanas, con las inasistencias recientes de cada paciente (para reforzar el recordatorio).
        query(
          `WITH ${CITAS},
           faltas AS (SELECT paciente_id, count(*) AS n FROM citas
                       WHERE es_cita_paciente AND grupo = 'No asistió' AND fecha_cita >= ${HOY} - 180 AND paciente_id IS NOT NULL GROUP BY 1)
           SELECT c.fecha_cita, to_char(c.hora_cita, 'HH24:MI') AS hora, c.nombre_paciente, c.tipo_servicio, c.modalidad,
                  c.estado_agenda, coalesce(f.n, 0) AS faltas_recientes
             FROM citas c LEFT JOIN faltas f USING (paciente_id)
            WHERE c.es_cita_paciente AND c.profesional_nombre = $1 AND c.grupo = 'Programada' AND c.fecha_cita BETWEEN ${HOY} AND ${HOY} + 13
            ORDER BY c.fecha_cita, c.hora_cita LIMIT 300`,
          [nombre],
        ),
        // Pacientes suyos con 2 o más inasistencias en los últimos 120 días.
        query(
          `WITH ${CITAS}
           SELECT max(nombre_paciente) AS paciente,
                  count(*) FILTER (WHERE grupo = 'No asistió') AS faltas,
                  count(*) FILTER (WHERE grupo = 'Asistió') AS atendidas,
                  max(fecha_cita) FILTER (WHERE grupo = 'No asistió') AS ultima_falta,
                  min(fecha_cita) FILTER (WHERE grupo = 'Programada') AS proxima
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $1 AND paciente_id IS NOT NULL
              AND fecha_cita BETWEEN ${HOY} - 120 AND ${HOY} + 60
            GROUP BY paciente_id
           HAVING count(*) FILTER (WHERE grupo = 'No asistió') >= 2
            ORDER BY 2 DESC, 4 DESC LIMIT 50`,
          [nombre],
        ),
        query(
          `WITH ${CITAS}
           SELECT to_char(fecha_cita, 'YYYY-MM') AS mes,
                  count(*) FILTER (WHERE grupo = 'Asistió') AS asistio,
                  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio,
                  count(*) FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $1 AND fecha_cita >= date_trunc('month', ${HOY}) - interval '11 months'
              AND fecha_cita <= ${HOY}
            GROUP BY 1 ORDER BY 1`,
          [nombre],
        ),
        // Ocupación (días pasados del período) y cupos libres de los próximos 14 días, si tiene horario registrado.
        hastaAyer(r.hasta) >= (r.desde > CAPACIDAD_DESDE ? r.desde : CAPACIDAD_DESDE)
          ? queryOne<{ cupos: number | null; ocupan: number | null }>(
              `WITH ${CITAS}, ${capacidad('$1', '$2')}
               SELECT sum(cupos) AS cupos, sum(ocupan) AS ocupan FROM capacidad
                WHERE regexp_replace(trim(profesional), '\\s+', ' ', 'g') = $3`,
              [r.desde, hastaAyer(r.hasta), nombre],
            )
          : Promise.resolve({ cupos: null, ocupan: null }),
        // Mismo cálculo que el centro de capacidad: cupos del horario sin cita, desde ahora.
        query<{ fecha: string; cupos: number; libres: number; primera_libre: string | null }>(
          `WITH ${CITAS}, ${slots('$1', '$2')}
           SELECT fecha, count(*) AS cupos, count(*) FILTER (WHERE NOT ocupado) AS libres,
                  to_char(min(hora) FILTER (WHERE NOT ocupado), 'HH24:MI') AS primera_libre
             FROM slots
            WHERE regexp_replace(trim(profesional), '\\s+', ' ', 'g') = $3
              AND (fecha > ${HOY} OR hora > (now() AT TIME ZONE 'America/Bogota')::time)
            GROUP BY 1 ORDER BY 1`,
          [hoy, sumarDias(hoy, 13), nombre],
        ),
      ]);
      return { vinculado: true, nombre, kpis, proximas, faltan, mensual, ocupacion, libres };
    });
  });

  // Consola de soporte: profesionales que aparecen en la agenda (para vincular un usuario con "Mi agenda").
  app.get('/api/soporte/profesionales', async () => ({
    filas: await query(
      `WITH ${CITAS}
       SELECT profesional_nombre AS nombre, max(especialidad) AS especialidad, count(*) AS citas_90d
         FROM citas
        WHERE es_cita_paciente AND profesional_nombre <> '' AND fecha_cita BETWEEN ${HOY} - 90 AND ${HOY} + 30
        GROUP BY 1 ORDER BY 1`,
    ),
  }));
}
