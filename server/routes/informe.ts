// Etapa 5: informe ejecutivo mensual y resumen semanal. Las cifras salen de los mismos endpoints de cada pantalla
// (con su caché y sus permisos); este endpoint solo controla el acceso (plan Full, Dirección y Analista) y entrega
// los datos de la portada y los períodos que se pueden elegir.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hoyBogota, sumarDias } from '../params.js';

const IPS = 'Centro de Orientación Diana Rodríguez';

function contexto(req: FastifyRequest) {
  const ctx = req.contexto!;
  return { ips: IPS, hoy: hoyBogota(), historialDesde: ctx.historialDesde, preparadoPara: ctx.nombre ?? ctx.usuario };
}

/** Lunes de la semana de `dia` (AAAA-MM-DD). */
const lunes = (dia: string) => sumarDias(dia, -((new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7));

export default async function rutasInforme(app: FastifyInstance) {
  // Meses completos disponibles (los últimos 12, sin pasar del inicio de los datos ni del historial del plan).
  app.get('/api/informe', async (req) => {
    const c = contexto(req);
    const minimo = [c.historialDesde ?? '2025-08-01', '2025-08-01'].sort().reverse()[0].slice(0, 7);
    const meses: string[] = [];
    const [a, m] = c.hoy.split('-').map(Number);
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.UTC(a, m - 1 - i, 1)).toISOString().slice(0, 7);
      if (d >= minimo) meses.push(d);
    }
    return { ...c, meses };
  });

  // Semanas completas (lunes a domingo) de las últimas 8.
  app.get('/api/informe/semanal', async (req) => {
    const c = contexto(req);
    const ultimaLunes = sumarDias(lunes(c.hoy), -7);
    const semanas: string[] = [];
    for (let i = 0; i < 8; i++) {
      const s = sumarDias(ultimaLunes, -7 * i);
      if (!c.historialDesde || s >= c.historialDesde) semanas.push(s);
    }
    return { ...c, semanas };
  });
}
