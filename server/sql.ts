// Fragmentos SQL compartidos. Todo sale del esquema `bi` (vistas de reportería de proyecto-ips,
// migración 030) y de unas pocas tablas de lista de espera con SELECT explícito al rol panel_lectura.
// Definiciones: docs/catalogo-analitica.md (TR-02, TR-03, sección 5 `bi.fact_citas_enriquecida`).
import { INCIDENTES } from './incidentes.js';

/** Fecha de hoy en Bogotá. */
export const HOY = `(now() AT TIME ZONE 'America/Bogota')::date`;

/**
 * Agrupa los valores reales de estado_agenda (incluidos los que no están en el enum del backend:
 * 'Reprogramar', 'Anulado' y la basura 'PROGRAMADA') en los grupos que ve el cliente.
 * "Sin cierre" (TR-03): cita pasada que sigue Pendiente/Confirmado; no se sabe si ocurrió.
 */
export const GRUPO_ESTADO = `
  CASE
    WHEN estado_agenda = 'Asistio' THEN 'Asistió'
    WHEN estado_agenda = 'No Asistio' THEN 'No asistió'
    WHEN estado_agenda IN ('Cancelado', 'Anulado') THEN 'Cancelada'
    WHEN estado_agenda = 'Reprogramar' THEN 'Reprogramada'
    WHEN estado_agenda IN ('Pendiente', 'Confirmado') AND fecha_cita < ${HOY} THEN 'Sin cierre'
    WHEN estado_agenda IN ('Pendiente', 'Confirmado') THEN 'Programada'
    ELSE 'Otro'
  END`;

/** Rangos de fechas de los incidentes de agenda, como VALUES para SQL (fechas fijas, sin parámetros). */
const RANGOS_AGENDA = INCIDENTES.filter((i) => i.area === 'agenda' || i.area === 'general')
  .map((i) => `(DATE '${i.desde}', DATE '${i.hasta}')`)
  .join(', ');

/**
 * CTE `citas`: bi.fact_citas enriquecida con la clasificación del catálogo analítico.
 * - es_cita_paciente (TR-02): excluye reuniones internas y bloques administrativos.
 * - tipo_servicio, modalidad, tipo_pago, rango_edad, franja, anticipación de registro.
 * - periodo_confiable: false si la cita cae en un incidente de agenda o 15 días antes
 *   (la ventana hacia atrás del scraper no alcanzó a cerrar esas citas).
 * Uso: `WITH ${CITAS} SELECT ... FROM citas WHERE es_cita_paciente AND ...`
 */
export const CITAS = `citas AS (
  SELECT b.*,
    CASE
      WHEN estado_agenda = 'Asistio' THEN 'Asistió'
      WHEN estado_agenda = 'No Asistio' THEN 'No asistió'
      WHEN estado_agenda IN ('Cancelado', 'Anulado') THEN 'Cancelada'
      WHEN estado_agenda = 'Reprogramar' THEN 'Reprogramada'
      WHEN estado_agenda IN ('Pendiente', 'Confirmado') AND fecha_cita < ${HOY} THEN 'Sin cierre'
      WHEN estado_agenda IN ('Pendiente', 'Confirmado') THEN 'Programada'
      ELSE 'Otro'
    END AS grupo,
    NOT (cat_norm = '' OR cat_norm LIKE 'REUNION%' OR cat_norm LIKE 'GASTOS%') AS es_cita_paciente,
    CASE
      WHEN cat_norm = '' OR cat_norm LIKE 'REUNION%' OR cat_norm LIKE 'GASTOS%' THEN 'administrativa'
      WHEN cat_norm LIKE 'INTERVENCION EN CRISIS%' THEN 'crisis'
      WHEN cat_norm LIKE '%PRIMERA VEZ%' THEN 'primera_vez'
      WHEN cat_norm LIKE '%PSICOTERAPIA%' THEN 'psicoterapia'
      WHEN cat_norm LIKE '%REHABILITACION%' THEN 'rehabilitacion'
      WHEN cat_norm LIKE '%PRUEBA%' OR cat_norm LIKE 'INFORME%' OR cat_norm LIKE '%VALORACION%'
           OR cat_norm LIKE 'PAQUETE DE NEUROPSICOLOGIA%' OR cat_norm LIKE 'EVALUACION%' THEN 'evaluacion'
      WHEN cat_norm LIKE '%CONTROL%' OR cat_norm LIKE '%SEGUIMIENTO%' OR cat_norm LIKE 'PAQUETE (10)%' THEN 'control'
      WHEN cat_norm LIKE 'TALLER%' OR cat_norm LIKE 'PROGRAMA%' THEN 'empresarial'
      ELSE 'otro'
    END AS tipo_servicio,
    CASE tipo_cita WHEN 1 THEN 'presencial' WHEN 4 THEN 'virtual' ELSE 'sin_dato' END AS modalidad,
    CASE WHEN coalesce(nullif(trim(administradora), ''), 'Particular') = 'Particular' THEN 'particular' ELSE 'convenio' END AS tipo_pago,
    coalesce(nullif(trim(administradora), ''), 'Particular') AS administradora_n,
    CASE
      WHEN edad_paciente IS NULL THEN 'sin_dato'
      WHEN edad_paciente < 12 THEN '0-11'
      WHEN edad_paciente < 18 THEN '12-17'
      WHEN edad_paciente < 30 THEN '18-29'
      WHEN edad_paciente < 45 THEN '30-44'
      WHEN edad_paciente < 60 THEN '45-59'
      ELSE '60+'
    END AS rango_edad,
    extract(hour FROM hora_cita)::int AS hora,
    extract(isodow FROM fecha_cita)::int AS dia,
    (fecha_cita - created_at_bogota::date) AS anticipacion_registro_dias,
    NOT EXISTS (
      SELECT 1 FROM (VALUES ${RANGOS_AGENDA}) AS i(desde, hasta)
      WHERE b.fecha_cita BETWEEN i.desde - 15 AND i.hasta
    ) AS periodo_confiable
  FROM (
    SELECT c.*,
      upper(translate(coalesce(c.catalogo, ''), 'ÁÉÍÓÚáéíóú', 'AEIOUAEIOU')) AS cat_norm,
      regexp_replace(trim(coalesce(c.profesional, '')), '\\s+', ' ', 'g') AS profesional_nombre
    FROM bi.fact_citas c
  ) b
)`;

/** Serie de períodos (día o semana) entre $1 y $2; $3 = 'day' | 'week'. */
export const PERIODOS = `
  SELECT generate_series(date_trunc($3, $1::date), $2::date, ('1 ' || $3)::interval)::date AS periodo`;

/** Columna de período para agrupar; `col` debe ser una fecha. */
export const periodo = (col: string) => `date_trunc($3, ${col})::date`;

/** Meses desde el inicio de los datos (ago-2025) hasta hoy, para tendencias largas. */
export const MESES = `
  SELECT to_char(m, 'YYYY-MM') AS mes
    FROM generate_series(DATE '2025-08-01', date_trunc('month', ${HOY}), interval '1 month') AS m`;

/** Conteo de inasistencia en citas cerradas: no_show % = no_asistio / (asistio + no_asistio). */
export const NOSHOW = `
  count(*) FILTER (WHERE grupo IN ('Asistió', 'No asistió')) AS cerradas,
  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio`;
