// Identificación de la red del cliente. NUNCA use `req.ip` para límites ni auditoría (H3): con
// `trustProxy: true` y `$proxy_add_x_forwarded_for` el navegador puede falsificarla. nginx sobrescribe `X-Real-IP`
// con `$remote_addr`, que sí es confiable.
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { AGENTE_MAX, SIN_IP } from './configuracion.js';

/** IP del cliente, o null si falta o no es una IP válida (una IP inválida rompería una columna `inet`, H18). */
export function ipDe(req: FastifyRequest): string | null {
  const h = req.headers['x-real-ip'];
  const ip = typeof h === 'string' ? h.trim() : '';
  return isIP(ip) ? ip : null;
}

/** IP para usar como clave de un contador. */
export const claveIp = (req: FastifyRequest) => ipDe(req) ?? SIN_IP;

/** Agente de usuario recortado y sin caracteres de control. */
export function agenteDe(req: FastifyRequest): string | null {
  const h = req.headers['user-agent'];
  if (typeof h !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const limpio = h.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, AGENTE_MAX);
  return limpio || null;
}

/** "Chrome en Windows", "Safari en iPhone"… para la lista de sesiones. Heurística simple, solo para mostrar. */
export function equipoDe(agente: string | null): string {
  if (!agente) return 'Equipo desconocido';
  const navegador = /Edg\//.test(agente) ? 'Edge' : /OPR\/|Opera/.test(agente) ? 'Opera' : /Firefox\//.test(agente) ? 'Firefox' : /Chrome\//.test(agente) ? 'Chrome' : /Safari\//.test(agente) ? 'Safari' : 'Navegador';
  const sistema = /Windows/.test(agente) ? 'Windows' : /Android/.test(agente) ? 'Android' : /iPhone|iPad|iOS/.test(agente) ? 'iPhone o iPad' : /Mac OS X|Macintosh/.test(agente) ? 'Mac' : /Linux/.test(agente) ? 'Linux' : 'otro sistema';
  return `${navegador} en ${sistema}`;
}
