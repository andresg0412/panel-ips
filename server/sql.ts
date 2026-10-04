// Fragmentos SQL compartidos. Todo sale del esquema `bi` (vistas de reportería de proyecto-ips,
// migración 030) y de unas pocas tablas de lista de espera con SELECT explícito al rol panel_lectura.

/**
 * Agrupa los valores reales de estado_agenda (incluidos los que no están en el enum del backend:
 * 'Reprogramar', 'Anulado' y la basura 'PROGRAMADA') en los 5 grupos que ve el cliente.
 */
export const GRUPO_ESTADO = `
  CASE
    WHEN estado_agenda = 'Asistio' THEN 'Asistió'
    WHEN estado_agenda = 'No Asistio' THEN 'No asistió'
    WHEN estado_agenda IN ('Cancelado', 'Anulado') THEN 'Cancelada'
    WHEN estado_agenda = 'Reprogramar' THEN 'Reprogramada'
    WHEN estado_agenda IN ('Pendiente', 'Confirmado') THEN 'Programada'
    ELSE 'Otro'
  END`;

/** Serie de períodos (día o semana) entre $1 y $2; $3 = 'day' | 'week'. */
export const PERIODOS = `
  SELECT generate_series(date_trunc($3, $1::date), $2::date, ('1 ' || $3)::interval)::date AS periodo`;

/** Columna de período para agrupar; `col` debe ser una fecha. */
export const periodo = (col: string) => `date_trunc($3, ${col})::date`;
