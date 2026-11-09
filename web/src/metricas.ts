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
