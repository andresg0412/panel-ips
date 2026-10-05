// Esquema propio del panel (`panel`), dueño el rol panel_app. Las migraciones corren solas al arrancar, en orden
// y una sola vez (tabla panel.migraciones). No es una migración de proyecto-ips: el DatabaseManager del backend no
// las ve. El esquema y el rol se crean una vez con deploy/crear-esquema-panel.sql.
import { poolApp } from './db.js';
import { INCIDENTES_BASE } from './incidentes.js';

const MIGRACIONES: { nombre: string; sql: string }[] = [
  {
    nombre: '001_licencia_usuarios_alertas',
    sql: `
      CREATE TABLE panel.licencia (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        nivel text NOT NULL CHECK (nivel IN ('basico', 'intermedio', 'full')),
        contacto_whatsapp text,
        nota text,
        actualizado_at timestamptz NOT NULL DEFAULT now(),
        actualizado_por text
      );

      CREATE TABLE panel.licencia_historial (
        id bigserial PRIMARY KEY,
        nivel_anterior text,
        nivel_nuevo text NOT NULL,
        nota text,
        cambiado_por text,
        cambiado_at timestamptz NOT NULL DEFAULT now()
      );

      -- Usuario de nginx (basic auth) → rol. prioridad decide qué usuarios quedan activos cuando el nivel limita
      -- el número de usuarios (menor = primero). El rol soporte no cuenta en ese límite.
      CREATE TABLE panel.usuarios (
        usuario text PRIMARY KEY,
        rol text NOT NULL CHECK (rol IN ('direccion', 'operacion', 'analista', 'relacion', 'profesional', 'soporte')),
        nombre text,
        correo text,
        prioridad integer NOT NULL DEFAULT 100,
        activo boolean NOT NULL DEFAULT true,
        creado_at timestamptz NOT NULL DEFAULT now(),
        actualizado_at timestamptz NOT NULL DEFAULT now()
      );

      -- Alertas técnicas del rol soporte. Una fila por ocurrencia: mientras no esté resuelta, el vigilante la
      -- actualiza; cuando la condición desaparece, la cierra sola (resuelta_auto).
      CREATE TABLE panel.alertas (
        id bigserial PRIMARY KEY,
        clave text NOT NULL,
        grupo text NOT NULL,
        severidad text NOT NULL CHECK (severidad IN ('alta', 'media', 'baja')),
        titulo text NOT NULL,
        detalle text,
        impacto text,
        enlace text,
        estado text NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'revisada', 'silenciada', 'resuelta')),
        primera_vez timestamptz NOT NULL DEFAULT now(),
        ultima_vez timestamptz NOT NULL DEFAULT now(),
        silenciada_hasta timestamptz,
        resuelta_at timestamptz,
        resuelta_auto boolean,
        nota text,
        actualizado_por text,
        actualizado_at timestamptz
      );
      CREATE UNIQUE INDEX uq_alertas_abierta ON panel.alertas (clave) WHERE estado <> 'resuelta';
      CREATE INDEX ix_alertas_estado ON panel.alertas (estado, ultima_vez DESC);

      CREATE TABLE panel.incidentes (
        id serial PRIMARY KEY,
        area text NOT NULL CHECK (area IN ('general', 'agenda', 'whatsapp', 'conversaciones', 'eventos', 'trazabilidad')),
        desde date NOT NULL,
        hasta date NOT NULL,
        titulo text NOT NULL,
        descripcion text NOT NULL,
        creado_por text,
        creado_at timestamptz NOT NULL DEFAULT now(),
        CHECK (hasta >= desde)
      );

      -- Qué hace cada persona en el panel: consultas a la API, pantallas vistas, descargas y cambios de configuración.
      CREATE TABLE panel.actividad (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        usuario text,
        rol text,
        tipo text NOT NULL CHECK (tipo IN ('api', 'visita', 'exportacion', 'configuracion', 'acceso_denegado')),
        ruta text,
        detalle text,
        status integer,
        ms integer,
        vista_previa boolean NOT NULL DEFAULT false
      );
      CREATE INDEX ix_actividad_at ON panel.actividad (at DESC);
      CREATE INDEX ix_actividad_usuario ON panel.actividad (usuario, at DESC);

      CREATE TABLE panel.vigilante (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        ultima_ejecucion timestamptz,
        duracion_ms integer,
        errores jsonb NOT NULL DEFAULT '[]'
      );
    `,
  },
];

/** Configuración inicial (solo si no existe): nivel Full y los usuarios que ya tiene nginx, con su rol. */
async function sembrar() {
  await poolApp!.query(`INSERT INTO panel.licencia (id, nivel, actualizado_por) VALUES (1, 'full', 'instalacion') ON CONFLICT DO NOTHING`);
  await poolApp!.query(
    `INSERT INTO panel.usuarios (usuario, rol, nombre, correo, prioridad) VALUES
       ('soporte', 'soporte', 'Soporte técnico', NULL, 0),
       ('gerencia', 'direccion', 'Gerencia', 'gerencia@centrodeorientacion.com.co', 1),
       ('analista', 'analista', 'Analista', NULL, 2),
       ('marketing', 'relacion', 'Marketing', NULL, 3),
       ('profesional', 'profesional', 'Profesional', NULL, 4)
     ON CONFLICT DO NOTHING`,
  );
  await poolApp!.query(`INSERT INTO panel.vigilante (id) VALUES (1) ON CONFLICT DO NOTHING`);
  const { rows } = await poolApp!.query<{ n: number }>(`SELECT count(*)::int AS n FROM panel.incidentes`);
  if (rows[0].n === 0) {
    for (const i of INCIDENTES_BASE) {
      await poolApp!.query(
        `INSERT INTO panel.incidentes (area, desde, hasta, titulo, descripcion, creado_por) VALUES ($1, $2, $3, $4, $5, 'instalacion')`,
        [i.area, i.desde, i.hasta, i.titulo, i.descripcion],
      );
    }
  }
}

export async function prepararEsquema(log: (msg: string) => void) {
  if (!poolApp) {
    log('DATABASE_URL_APP no está configurada: el panel no puede leer roles ni licencia');
    return;
  }
  await poolApp.query(`CREATE TABLE IF NOT EXISTS panel.migraciones (nombre text PRIMARY KEY, aplicada_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await poolApp.query<{ nombre: string }>(`SELECT nombre FROM panel.migraciones`);
  const hechas = new Set(rows.map((r) => r.nombre));
  for (const m of MIGRACIONES) {
    if (hechas.has(m.nombre)) continue;
    const cli = await poolApp.connect();
    try {
      await cli.query('BEGIN');
      await cli.query(m.sql);
      await cli.query(`INSERT INTO panel.migraciones (nombre) VALUES ($1)`, [m.nombre]);
      await cli.query('COMMIT');
      log(`Migración del panel aplicada: ${m.nombre}`);
    } catch (e) {
      await cli.query('ROLLBACK');
      throw e;
    } finally {
      cli.release();
    }
  }
  await sembrar();
}
