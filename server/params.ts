const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;
const MAX_DIAS = 800;

export class ErrorParametro extends Error {}

export interface Rango {
  desde: string;
  hasta: string;
  dias: number;
  /** Período inmediatamente anterior, de la misma duración (para comparar). */
  prevDesde: string;
  prevHasta: string;
  /** 'day' si el rango es corto, 'week' si es largo. */
  grano: 'day' | 'week';
}

function hoyBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function sumarDias(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

export function leerRango(q: Record<string, unknown>): Rango {
  const hasta = typeof q.hasta === 'string' && q.hasta ? q.hasta : hoyBogota();
  const desde = typeof q.desde === 'string' && q.desde ? q.desde : sumarDias(hasta, -29);
  if (!FECHA.test(desde) || !FECHA.test(hasta) || Number.isNaN(Date.parse(desde)) || Number.isNaN(Date.parse(hasta))) {
    throw new ErrorParametro('Fechas inválidas: use el formato AAAA-MM-DD');
  }
  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / DIA_MS) + 1;
  if (dias < 1) throw new ErrorParametro('La fecha inicial es posterior a la final');
  if (dias > MAX_DIAS) throw new ErrorParametro(`El rango máximo es de ${MAX_DIAS} días`);
  return {
    desde,
    hasta,
    dias,
    prevDesde: sumarDias(desde, -dias),
    prevHasta: sumarDias(desde, -1),
    grano: dias <= 62 ? 'day' : 'week',
  };
}

export function leerTexto(q: Record<string, unknown>, nombre: string, max = 100): string | null {
  const v = q[nombre];
  if (typeof v !== 'string' || v.trim() === '') return null;
  return v.trim().slice(0, max);
}

export function leerPagina(q: Record<string, unknown>, porDefecto = 50, maximo = 500) {
  const pagina = Math.max(1, Number.parseInt(String(q.pagina ?? '1'), 10) || 1);
  const tam = Math.min(maximo, Math.max(1, Number.parseInt(String(q.tam ?? porDefecto), 10) || porDefecto));
  return { pagina, tam, offset: (pagina - 1) * tam };
}
