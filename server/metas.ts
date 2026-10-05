// Metas de los indicadores de la sala de control (Etapa 2). Viven en panel.metas: las edita soporte siempre y la
// Dirección en el plan Full. Las tasas van de 0 a 1; las metas mensuales se prorratean a los días del período.
import { MODO_LEGADO } from './acceso.js';
import { queryApp } from './db.js';

export type TipoMeta = 'tasa' | 'mensual';

export interface DefIndicador {
  titulo: string;
  tipo: TipoMeta;
  mejorSiSube: boolean;
  /** Valor inicial de referencia (null = sin meta hasta que alguien la defina). */
  defecto: number | null;
}

export const INDICADORES: Record<string, DefIndicador> = {
  atendidas: { titulo: 'Citas atendidas', tipo: 'mensual', mejorSiSube: true, defecto: null },
  asistencia: { titulo: 'Tasa de asistencia', tipo: 'tasa', mejorSiSube: true, defecto: 0.92 },
  no_ocurrieron: { titulo: 'Cancelaciones y reprogramaciones', tipo: 'tasa', mejorSiSube: false, defecto: 0.25 },
  nuevos: { titulo: 'Pacientes nuevos atendidos', tipo: 'mensual', mejorSiSube: true, defecto: null },
  ocupacion: { titulo: 'Ocupación de la agenda', tipo: 'tasa', mejorSiSube: true, defecto: 0.85 },
  tramites: { titulo: 'Trámites resueltos por WhatsApp', tipo: 'mensual', mejorSiSube: true, defecto: null },
  confirmadas_whatsapp: { titulo: 'Citas confirmadas por WhatsApp', tipo: 'tasa', mejorSiSube: true, defecto: 0.4 },
};

export interface Meta extends DefIndicador {
  valor: number | null;
  actualizado_por: string | null;
  actualizado_at: string | null;
}

/** Metas vigentes: las guardadas en panel.metas y, para el resto, el valor de referencia. */
export async function leerMetas(): Promise<Record<string, Meta>> {
  const filas = MODO_LEGADO
    ? []
    : await queryApp<{ indicador: string; valor: number; actualizado_por: string | null; actualizado_at: string }>(
        `SELECT indicador, valor, actualizado_por,
                to_char(actualizado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS actualizado_at
           FROM panel.metas`,
      );
  const guardadas = new Map(filas.map((f) => [f.indicador, f]));
  return Object.fromEntries(
    Object.entries(INDICADORES).map(([k, d]) => {
      const g = guardadas.get(k);
      return [k, { ...d, valor: g ? Number(g.valor) : d.defecto, actualizado_por: g?.actualizado_por ?? null, actualizado_at: g?.actualizado_at ?? null }];
    }),
  );
}
