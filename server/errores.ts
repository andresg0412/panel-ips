// Manejador global de errores del panel (antes vivía dentro de index.ts; se extrajo para poder probarlo con los
// mismos hooks y rutas reales).
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorHistorialPlan, ErrorParametro } from './params.js';
import { ErrorAuth } from './auth/errores.js';
import { registrarError } from './acceso.js';

export function manejarError(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ErrorAuth) {
    // Un 429 dice cuánto esperar, también en la cabecera estándar.
    if (err.reintentarEnS) reply.header('Retry-After', String(err.reintentarEnS));
    return reply.code(err.status).send({ error: err.message, codigo: err.codigo });
  }
  if (err instanceof ErrorParametro) return reply.code(400).send({ error: err.message });
  if (err instanceof ErrorHistorialPlan) return reply.code(402).send({ error: err.message, codigo: 'historial', nivel: err.nivel });
  const e = err as { code?: string; message: string; validation?: unknown; statusCode?: number };
  // Datos inválidos de la API de autenticación: el cliente decide por `codigo`, no por el texto.
  if (e.validation) return reply.code(400).send({ error: `Datos inválidos: ${e.message}`, codigo: 'datos' });
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  // 57014 = statement_timeout de Postgres.
  if (e.code === '57014') {
    req.log.warn({ url: req.url }, 'consulta cancelada por tiempo');
    registrarError('timeout');
    return reply.code(503).send({ error: 'La consulta tardó demasiado. Pruebe con un rango de fechas más corto.' });
  }
  if (e.code === 'ECONNREFUSED' || e.code === '57P03' || e.code === 'ENOTFOUND') {
    registrarError('bd');
    return reply.code(503).send({ error: 'La base de datos no está disponible en este momento (posible despliegue en curso).' });
  }
  // Nunca se registra el cuerpo de la petición (puede traer contraseñas): solo el error.
  req.log.error(err);
  registrarError('interno');
  return reply.code(500).send({ error: 'Error interno del panel' });
}
