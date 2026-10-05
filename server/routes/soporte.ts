// Consola del rol soporte (German): alertas técnicas, licencia, usuarios y roles, actividad e incidentes de datos.
// El acceso lo restringe acceso.ts: todo /api/soporte/* exige el rol soporte real (no la vista previa).
import type { FastifyInstance } from 'fastify';
import { queryApp } from '../db.js';
import { conCache } from '../cache.js';
import { invalidarConfig, obtenerConfig, registrarActividad } from '../acceso.js';
import { MAX_USUARIOS, NOMBRE_NIVEL, esNivel, esRol } from '../funciones.js';
import { AREAS_INCIDENTE, recargarIncidentes } from '../incidentes.js';
import { ejecutarVigilante, estadoVigilante } from '../vigilante.js';
import { ErrorParametro } from '../params.js';

const FECHA = '^\\d{4}-\\d{2}-\\d{2}$';
const COLS_ALERTA = `id, clave, grupo, severidad, titulo, detalle, impacto, enlace, estado,
  to_char(primera_vez AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS primera_vez, to_char(ultima_vez AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS ultima_vez, to_char(silenciada_hasta AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS silenciada_hasta,
  to_char(resuelta_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS resuelta_at, resuelta_auto, nota, actualizado_por, to_char(actualizado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS actualizado_at`;

export default async function rutasSoporte(app: FastifyInstance) {
  // Contador para el menú: alertas activas (no revisadas ni silenciadas).
  app.get('/api/soporte/conteo', async () =>
    conCache(
      'soporte:conteo',
      async () => {
        const [r] = await queryApp<{ n: number; altas: number }>(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE severidad = 'alta')::int AS altas FROM panel.alertas WHERE estado = 'activa'`,
        );
        return r;
      },
      30_000,
      0, // sin gracia: el contador de alertas no debe mostrarse vencido
    ),
  );

  // --------------------------------------------------------------------------------------- alertas
  app.get('/api/soporte/alertas', async () => {
    const [abiertas, resueltas, [vig]] = await Promise.all([
      queryApp(
        `SELECT ${COLS_ALERTA} FROM panel.alertas WHERE estado <> 'resuelta'
          ORDER BY CASE estado WHEN 'activa' THEN 0 WHEN 'revisada' THEN 1 ELSE 2 END,
                   CASE severidad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, ultima_vez DESC`,
      ),
      queryApp(`SELECT ${COLS_ALERTA} FROM panel.alertas WHERE estado = 'resuelta' AND resuelta_at > now() - interval '30 days' ORDER BY resuelta_at DESC LIMIT 100`),
      queryApp<{ ultima_ejecucion: string | null; duracion_ms: number | null; errores: unknown }>(
        `SELECT to_char(ultima_ejecucion AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS ultima_ejecucion, duracion_ms, errores FROM panel.vigilante WHERE id = 1`,
      ),
    ]);
    return { abiertas, resueltas, vigilante: { ...vig, comprobaciones: estadoVigilante()?.comprobaciones ?? [] } };
  });

  app.post(
    '/api/soporte/alertas/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } },
        body: {
          type: 'object',
          required: ['estado'],
          additionalProperties: false,
          properties: {
            estado: { type: 'string', enum: ['activa', 'revisada', 'silenciada', 'resuelta'] },
            nota: { type: 'string', maxLength: 500 },
            horas: { type: 'integer', minimum: 1, maximum: 24 * 30 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const b = req.body as { estado: string; nota?: string; horas?: number };
      if (b.estado === 'silenciada' && !b.horas) throw new ErrorParametro('Indique por cuántas horas se silencia');
      const filas = await queryApp(
        `UPDATE panel.alertas
            SET estado = $2,
                nota = coalesce($3, nota),
                silenciada_hasta = CASE WHEN $2 = 'silenciada' THEN now() + make_interval(hours => $4) ELSE NULL END,
                resuelta_at = CASE WHEN $2 = 'resuelta' THEN now() ELSE NULL END,
                resuelta_auto = CASE WHEN $2 = 'resuelta' THEN false ELSE NULL END,
                actualizado_por = $5, actualizado_at = now()
          WHERE id = $1 AND estado <> 'resuelta'
          RETURNING ${COLS_ALERTA}`,
        [id, b.estado, b.nota ?? null, b.horas ?? 0, req.contexto!.usuario],
      );
      if (!filas.length) return reply.code(404).send({ error: 'La alerta no existe o ya está resuelta' });
      registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'alerta', detalle: `${id} → ${b.estado}`, status: 200, ms: null });
      return filas[0];
    },
  );

  app.post('/api/soporte/vigilante/ejecutar', async () => {
    await ejecutarVigilante();
    return { ok: true, vigilante: estadoVigilante() };
  });

  // -------------------------------------------------------------------------------------- licencia
  app.get('/api/soporte/licencia', async () => {
    const cfg = await obtenerConfig();
    const historial = await queryApp(
      `SELECT nivel_anterior, nivel_nuevo, nota, cambiado_por, to_char(cambiado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS cambiado_at
         FROM panel.licencia_historial ORDER BY cambiado_at DESC LIMIT 50`,
    );
    return { licencia: cfg.licencia, historial, usuariosPermitidos: cfg.permitidos.size, maxUsuarios: MAX_USUARIOS[cfg.licencia.nivel] };
  });

  app.put(
    '/api/soporte/licencia',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nivel: { type: 'string', enum: ['basico', 'intermedio', 'full'] },
            nota: { type: 'string', maxLength: 500 },
            contacto_whatsapp: { type: 'string', maxLength: 20, pattern: '^[0-9]*$' },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as { nivel?: string; nota?: string; contacto_whatsapp?: string };
      const quien = req.contexto!.usuario;
      const cfg = await obtenerConfig();
      if (b.nivel && esNivel(b.nivel) && b.nivel !== cfg.licencia.nivel) {
        await queryApp(
          `INSERT INTO panel.licencia_historial (nivel_anterior, nivel_nuevo, nota, cambiado_por) VALUES ($1, $2, $3, $4)`,
          [cfg.licencia.nivel, b.nivel, b.nota ?? null, quien],
        );
        await queryApp(`UPDATE panel.licencia SET nivel = $1, nota = $2, actualizado_at = now(), actualizado_por = $3 WHERE id = 1`, [b.nivel, b.nota ?? null, quien]);
        registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'licencia', detalle: `${NOMBRE_NIVEL[cfg.licencia.nivel]} → ${NOMBRE_NIVEL[b.nivel]}`, status: 200, ms: null });
      }
      if (b.contacto_whatsapp !== undefined) {
        await queryApp(`UPDATE panel.licencia SET contacto_whatsapp = nullif($1, ''), actualizado_at = now(), actualizado_por = $2 WHERE id = 1`, [b.contacto_whatsapp, quien]);
      }
      invalidarConfig();
      const nueva = await obtenerConfig();
      return { licencia: nueva.licencia, usuariosPermitidos: nueva.permitidos.size, maxUsuarios: MAX_USUARIOS[nueva.licencia.nivel] };
    },
  );

  // -------------------------------------------------------------------------------------- usuarios
  app.get('/api/soporte/usuarios', async () => {
    const cfg = await obtenerConfig();
    const uso = await queryApp<{ usuario: string; ultimo: string | null; visitas_7d: number; consultas_7d: number; exportaciones_30d: number }>(
      `SELECT usuario,
              to_char(max(at) FILTER (WHERE tipo = 'visita' OR (tipo = 'api' AND status < 400)) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS ultimo,
              count(*) FILTER (WHERE tipo = 'visita' AND at > now() - interval '7 days')::int AS visitas_7d,
              count(*) FILTER (WHERE tipo = 'api' AND at > now() - interval '7 days')::int AS consultas_7d,
              count(*) FILTER (WHERE tipo = 'exportacion' AND at > now() - interval '30 days')::int AS exportaciones_30d
         FROM panel.actividad WHERE usuario IS NOT NULL AND NOT vista_previa GROUP BY 1`,
    );
    const porUsuario = new Map(uso.map((u) => [u.usuario, u]));
    const filas = [...cfg.usuarios.values()]
      .sort((a, b) => a.prioridad - b.prioridad || a.usuario.localeCompare(b.usuario))
      .map((u) => ({
        ...u,
        enPlan: u.rol === 'soporte' || cfg.permitidos.has(u.usuario),
        ultimo: porUsuario.get(u.usuario)?.ultimo ?? null,
        visitas_7d: porUsuario.get(u.usuario)?.visitas_7d ?? 0,
        consultas_7d: porUsuario.get(u.usuario)?.consultas_7d ?? 0,
        exportaciones_30d: porUsuario.get(u.usuario)?.exportaciones_30d ?? 0,
      }));
    return { filas, maxUsuarios: MAX_USUARIOS[cfg.licencia.nivel] };
  });

  app.put(
    '/api/soporte/usuarios/:usuario',
    {
      schema: {
        params: { type: 'object', properties: { usuario: { type: 'string', pattern: '^[A-Za-z0-9._-]{2,40}$' } } },
        body: {
          type: 'object',
          required: ['rol'],
          additionalProperties: false,
          properties: {
            rol: { type: 'string' },
            nombre: { type: 'string', maxLength: 100 },
            correo: { type: 'string', maxLength: 150 },
            prioridad: { type: 'integer', minimum: 0, maximum: 999 },
            activo: { type: 'boolean' },
            // '' quita el vínculo.
            profesional: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (req) => {
      const { usuario } = req.params as { usuario: string };
      const b = req.body as { rol: string; nombre?: string; correo?: string; prioridad?: number; activo?: boolean; profesional?: string };
      if (!esRol(b.rol)) throw new ErrorParametro('Rol inválido');
      // Evita quedarse sin acceso a la consola.
      if (usuario === req.contexto!.usuario && (b.rol !== 'soporte' || b.activo === false)) {
        throw new ErrorParametro('No puede quitarse a sí mismo el rol de soporte');
      }
      const [fila] = await queryApp(
        `INSERT INTO panel.usuarios (usuario, rol, nombre, correo, prioridad, activo, profesional)
         VALUES ($1, $2, nullif($3, ''), nullif($4, ''), coalesce($5, 100), coalesce($6, true), nullif($7, ''))
         ON CONFLICT (usuario) DO UPDATE
            SET rol = EXCLUDED.rol,
                nombre = CASE WHEN $3::text IS NULL THEN panel.usuarios.nombre ELSE EXCLUDED.nombre END,
                correo = CASE WHEN $4::text IS NULL THEN panel.usuarios.correo ELSE EXCLUDED.correo END,
                prioridad = coalesce($5, panel.usuarios.prioridad),
                activo = coalesce($6, panel.usuarios.activo),
                profesional = CASE WHEN $7::text IS NULL THEN panel.usuarios.profesional ELSE EXCLUDED.profesional END,
                actualizado_at = now()
         RETURNING usuario, rol, nombre, correo, prioridad, activo, profesional`,
        [usuario, b.rol, b.nombre ?? null, b.correo ?? null, b.prioridad ?? null, b.activo ?? null, b.profesional === undefined ? null : b.profesional.trim()],
      );
      registrarActividad(req.contexto, {
        tipo: 'configuracion',
        ruta: 'usuario',
        detalle: `${usuario}: ${b.rol}${b.activo === false ? ' (desactivado)' : ''}${b.profesional ? ` · profesional ${b.profesional.trim()}` : ''}`,
        status: 200,
        ms: null,
      });
      invalidarConfig();
      return fila;
    },
  );

  // ------------------------------------------------------------------------------------- actividad
  app.get('/api/soporte/actividad', async (req) => {
    const q = req.query as Record<string, unknown>;
    const usuario = typeof q.usuario === 'string' && q.usuario ? q.usuario.slice(0, 40) : null;
    const tipo = typeof q.tipo === 'string' && q.tipo ? q.tipo.slice(0, 20) : null;
    const dias = Math.min(180, Math.max(1, Number.parseInt(String(q.dias ?? '7'), 10) || 7));
    const filtro = `at > now() - make_interval(days => $1) AND ($2::text IS NULL OR usuario = $2) AND ($3::text IS NULL OR tipo = $3)`;
    const [filas, pantallas, porDia, lentas] = await Promise.all([
      queryApp(
        `SELECT to_char(at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS at, usuario, rol, tipo, ruta, detalle, status, ms, vista_previa
           FROM panel.actividad WHERE ${filtro} ORDER BY at DESC LIMIT 300`,
        [dias, usuario, tipo],
      ),
      queryApp(
        `SELECT ruta AS clave, count(*)::int AS n FROM panel.actividad
          WHERE ${filtro} AND tipo = 'visita' AND NOT vista_previa GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
        [dias, usuario, tipo],
      ),
      queryApp(
        `SELECT (at AT TIME ZONE 'America/Bogota')::date::text AS fecha, count(DISTINCT usuario)::int AS usuarios,
                count(*) FILTER (WHERE tipo = 'visita')::int AS visitas
           FROM panel.actividad WHERE ${filtro} AND NOT vista_previa AND rol IS DISTINCT FROM 'soporte' GROUP BY 1 ORDER BY 1`,
        [dias, usuario, tipo],
      ),
      queryApp(
        `SELECT ruta AS clave, count(*)::int AS n, round(avg(ms))::int AS ms_promedio, max(ms)::int AS ms_max,
                count(*) FILTER (WHERE status >= 500)::int AS errores
           FROM panel.actividad WHERE ${filtro} AND tipo = 'api' GROUP BY 1 HAVING max(ms) > 2000 OR count(*) FILTER (WHERE status >= 500) > 0
          ORDER BY ms_max DESC LIMIT 15`,
        [dias, usuario, tipo],
      ),
    ]);
    return { filas, pantallas, porDia, lentas };
  });

  // ------------------------------------------------------------------------------------ incidentes
  const cuerpoIncidente = {
    type: 'object',
    required: ['area', 'desde', 'hasta', 'titulo', 'descripcion'],
    additionalProperties: false,
    properties: {
      area: { type: 'string', enum: AREAS_INCIDENTE },
      desde: { type: 'string', pattern: FECHA },
      hasta: { type: 'string', pattern: FECHA },
      titulo: { type: 'string', minLength: 3, maxLength: 120 },
      descripcion: { type: 'string', minLength: 3, maxLength: 500 },
    },
  };
  type CuerpoIncidente = { area: string; desde: string; hasta: string; titulo: string; descripcion: string };
  const validar = (b: CuerpoIncidente) => {
    if (b.hasta < b.desde) throw new ErrorParametro('La fecha final es anterior a la inicial');
  };

  app.get('/api/soporte/incidentes', async () => ({
    filas: await queryApp(
      `SELECT id, area, desde::text AS desde, hasta::text AS hasta, titulo, descripcion, creado_por, to_char(creado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS creado_at
         FROM panel.incidentes ORDER BY desde DESC, id DESC`,
    ),
  }));

  app.post('/api/soporte/incidentes', { schema: { body: cuerpoIncidente } }, async (req) => {
    const b = req.body as CuerpoIncidente;
    validar(b);
    const [fila] = await queryApp(
      `INSERT INTO panel.incidentes (area, desde, hasta, titulo, descripcion, creado_por) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.area, b.desde, b.hasta, b.titulo, b.descripcion, req.contexto!.usuario],
    );
    await recargarIncidentes();
    registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'incidente', detalle: `nuevo: ${b.titulo}`, status: 200, ms: null });
    return fila;
  });

  app.put(
    '/api/soporte/incidentes/:id',
    { schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } }, body: cuerpoIncidente } },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const b = req.body as CuerpoIncidente;
      validar(b);
      const filas = await queryApp(
        `UPDATE panel.incidentes SET area = $2, desde = $3, hasta = $4, titulo = $5, descripcion = $6 WHERE id = $1 RETURNING id`,
        [id, b.area, b.desde, b.hasta, b.titulo, b.descripcion],
      );
      if (!filas.length) return reply.code(404).send({ error: 'No existe' });
      await recargarIncidentes();
      registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'incidente', detalle: `editado: ${b.titulo}`, status: 200, ms: null });
      return filas[0];
    },
  );

  app.delete('/api/soporte/incidentes/:id', { schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const filas = await queryApp<{ titulo: string }>(`DELETE FROM panel.incidentes WHERE id = $1 RETURNING titulo`, [id]);
    if (!filas.length) return reply.code(404).send({ error: 'No existe' });
    await recargarIncidentes();
    registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'incidente', detalle: `eliminado: ${filas[0].titulo}`, status: 200, ms: null });
    return { ok: true };
  });
}
