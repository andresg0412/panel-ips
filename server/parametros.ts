// Parámetros editables del panel (Etapa 3). Viven en panel.parametros: los edita soporte siempre y la Dirección
// en el plan Full. Por ahora, los minutos que tomaría a recepción cada trámite si se hiciera por teléfono, para
// calcular las horas de recepción que ahorra el bot. Sin valor monetario: decisión de German (plan, sección 1.2-4).
import { MODO_LEGADO } from './acceso.js';
import { queryApp } from './db.js';

export interface DefParametro {
  titulo: string;
  unidad: string;
  defecto: number;
  min: number;
  max: number;
}

export const PARAMETROS: Record<string, DefParametro> = {
  min_agendar: { titulo: 'Agendar una cita', unidad: 'min', defecto: 8, min: 0, max: 60 },
  min_reprogramar: { titulo: 'Reprogramar una cita', unidad: 'min', defecto: 6, min: 0, max: 60 },
  min_cancelar: { titulo: 'Cancelar una cita', unidad: 'min', defecto: 4, min: 0, max: 60 },
  min_confirmar: { titulo: 'Confirmar una cita', unidad: 'min', defecto: 2, min: 0, max: 60 },
};

export interface Parametro extends DefParametro {
  valor: number;
  actualizado_por: string | null;
  actualizado_at: string | null;
}

export interface ConteoTramites {
  agendadas: number;
  reprogramadas: number;
  canceladas: number;
  confirmadas: number;
}

/** Minutos de recepción que habría tomado cada grupo de trámites por teléfono. */
export function minutosAhorrados(t: ConteoTramites, p: Record<string, { valor: number }>) {
  return {
    agendadas: t.agendadas * p.min_agendar.valor,
    reprogramadas: t.reprogramadas * p.min_reprogramar.valor,
    canceladas: t.canceladas * p.min_cancelar.valor,
    confirmadas: t.confirmadas * p.min_confirmar.valor,
  };
}

export const horasDe = (m: ReturnType<typeof minutosAhorrados>) => (m.agendadas + m.reprogramadas + m.canceladas + m.confirmadas) / 60;

/** Valores vigentes: los guardados en panel.parametros y, para el resto, el valor de referencia. */
export async function leerParametros(): Promise<Record<string, Parametro>> {
  const filas = MODO_LEGADO
    ? []
    : await queryApp<{ clave: string; valor: number; actualizado_por: string | null; actualizado_at: string }>(
        `SELECT clave, valor, actualizado_por,
                to_char(actualizado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS actualizado_at
           FROM panel.parametros`,
      );
  const guardados = new Map(filas.map((f) => [f.clave, f]));
  return Object.fromEntries(
    Object.entries(PARAMETROS).map(([k, d]) => {
      const g = guardados.get(k);
      return [k, { ...d, valor: g ? Number(g.valor) : d.defecto, actualizado_por: g?.actualizado_por ?? null, actualizado_at: g?.actualizado_at ?? null }];
    }),
  );
}
