import type { FastifyInstance } from 'fastify';
import { estadoPaginas, evaluar, obtenerConfig, registrarActividad } from '../acceso.js';
import { FUNCIONES, HISTORIAL_DIAS, MAX_USUARIOS, NIVELES, NOMBRE_NIVEL, PROXIMAMENTE, ROLES } from '../funciones.js';

export default async function rutasPlan(app: FastifyInstance) {
  // Quién es, qué rol y nivel rigen y qué puede ver: con esto el frontend arma el menú y los candados.
  app.get('/api/yo', async (req) => {
    const ctx = req.contexto!;
    const rol = ctx.habilitado ? ctx.rol : null;
    return {
      usuario: ctx.usuario,
      nombre: ctx.nombre,
      rol,
      rolNombre: rol ? ROLES[rol].nombre : null,
      rolReal: ctx.rolReal,
      nivel: ctx.nivel,
      nivelNombre: NOMBRE_NIVEL[ctx.nivel],
      nivelReal: ctx.nivelReal,
      vistaPrevia: ctx.vistaPrevia,
      historialDesde: ctx.historialDesde,
      habilitado: ctx.habilitado,
      mensaje: ctx.mensaje,
      inicio: rol ? (ctx.rolReal === 'soporte' && !ctx.vistaPrevia ? 'soporte' : ROLES[rol].inicio) : null,
      paginas: ctx.habilitado ? estadoPaginas(ctx) : {},
      funciones: Object.fromEntries(FUNCIONES.map((f) => [f.clave, ctx.habilitado ? evaluar(ctx, f.clave) : { ok: false, motivo: 'rol', nivel: f.nivel }])),
      niveles: NOMBRE_NIVEL,
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.nombre])),
    };
  });

  // Comparación de planes (pantalla "Mi plan").
  app.get('/api/plan', async (req) => {
    const cfg = await obtenerConfig();
    return {
      nivel: req.contexto!.nivel,
      contacto: cfg.licencia.contacto_whatsapp,
      niveles: NIVELES.map((n) => ({ clave: n, nombre: NOMBRE_NIVEL[n], historialDias: HISTORIAL_DIAS[n], maxUsuarios: MAX_USUARIOS[n] })),
      funciones: FUNCIONES.filter((f) => f.clave !== 'plan.ver').map((f) => ({ clave: f.clave, titulo: f.titulo, pagina: f.pagina, nivel: f.nivel })),
      proximamente: PROXIMAMENTE,
    };
  });

  // Pantallas vistas y descargas hechas en el navegador (las consultas a la API se registran solas).
  app.post(
    '/api/actividad',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tipo'],
          additionalProperties: false,
          properties: {
            tipo: { type: 'string', enum: ['visita', 'exportacion'] },
            ruta: { type: 'string', maxLength: 120 },
            detalle: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { tipo: 'visita' | 'exportacion'; ruta?: string; detalle?: string };
      if (req.contexto?.habilitado) registrarActividad(req.contexto, { tipo: b.tipo, ruta: b.ruta ?? null, detalle: b.detalle ?? null, status: null, ms: null });
      return reply.code(204).send();
    },
  );
}
