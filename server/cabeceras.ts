// Cabeceras de seguridad de todas las respuestas (H10, H11). Se instala antes de registrar las rutas y los archivos
// estáticos, para que ambos las hereden.
import type { FastifyInstance } from 'fastify';
import { esProduccion } from './auth/configuracion.js';

/**
 * `style-src 'unsafe-inline'` es necesario por los atributos `style` de React (y del SVG de los gráficos). Los
 * scripts SÍ son estrictos: solo los del propio sitio, lo que corta la mayoría de los XSS.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function instalarCabeceras(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    // La API nunca se guarda en caché (datos personales y de sesión). No se toca el Cache-Control de los archivos
    // estáticos: index.ts ya les pone el suyo. Se mira la ruta resuelta (la URL puede venir codificada); sin ruta, la URL.
    if ((req.routeOptions.url ?? req.url).startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (esProduccion()) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
