// Fórmulas de la agenda que comparten las pantallas. Definiciones: docs/catalogo-analitica.md (AGE-xx y D11).

/** Citas de pacientes por estado (una fila de `COLUMNAS_ESTADO` del servidor). */
export interface PorEstado {
  nombre?: string;
  dia?: number;
  total: number;
  asistio: number;
  no_asistio: number;
  canceladas: number;
  reprogramadas: number;
  programadas: number;
  sin_cierre?: number;
  horas_no_ocurrieron?: number | null;
}

/** Asistencia a citas realizadas = asistió ÷ (asistió + no asistió). */
export const realizadas = (f: Pick<PorEstado, 'asistio' | 'no_asistio'>) => f.asistio + f.no_asistio;
export const tasa = (f: PorEstado) => (realizadas(f) ? f.asistio / realizadas(f) : null);

// D11: cumplimiento = asistió ÷ (asistió + no asistió + canceladas); canceladas % sobre la misma base.
export const esperadas = (f: PorEstado) => f.asistio + f.no_asistio + f.canceladas;
export const cumplimiento = (f: PorEstado) => (esperadas(f) ? f.asistio / esperadas(f) : null);
export const canceladasPct = (f: PorEstado) => (esperadas(f) ? f.canceladas / esperadas(f) : null);

/** Porcentaje de no asistencia = no asistió ÷ (asistió + no asistió + canceladas), la misma base que Canceladas %. */
export const noAsistioPct = (f: PorEstado) => (esperadas(f) ? f.no_asistio / esperadas(f) : null);

/** Porcentaje de reprogramación = reprogramadas ÷ (asistió + no asistió + canceladas + reprogramadas). */
export const conReprogramadas = (f: PorEstado) => esperadas(f) + f.reprogramadas;
export const reprogramadasPct = (f: PorEstado) => (conReprogramadas(f) ? f.reprogramadas / conReprogramadas(f) : null);

/** Fila TOTAL de una tabla por estado: suma cada conteo de las filas que muestra la tabla. */
export function totalPorEstado(filas: PorEstado[]): PorEstado {
  const t: PorEstado = { nombre: 'TOTAL', total: 0, asistio: 0, no_asistio: 0, canceladas: 0, reprogramadas: 0, programadas: 0, sin_cierre: 0, horas_no_ocurrieron: 0 };
  for (const f of filas) {
    t.total += f.total;
    t.asistio += f.asistio;
    t.no_asistio += f.no_asistio;
    t.canceladas += f.canceladas;
    t.reprogramadas += f.reprogramadas;
    t.programadas += f.programadas;
    t.sin_cierre = (t.sin_cierre ?? 0) + (f.sin_cierre ?? 0);
    t.horas_no_ocurrieron = (t.horas_no_ocurrieron ?? 0) + (f.horas_no_ocurrieron ?? 0);
  }
  return t;
}
