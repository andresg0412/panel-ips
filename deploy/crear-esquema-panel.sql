-- Etapa 1 (2026-10-04): rol panel_app y esquema `panel` (licencia, usuarios y roles, alertas de soporte,
-- actividad, incidentes de datos). Se ejecuta una vez, como el usuario admin de Postgres, después de crear-rol.sql.
-- No modifica ninguna tabla ni vista existente. Las tablas del esquema las crea el propio panel al arrancar
-- (server/esquema.ts), porque panel_app es dueño del esquema.
-- Uso: psql -v pass="'<password>'" -f crear-esquema-panel.sql

CREATE ROLE panel_app LOGIN PASSWORD :pass CONNECTION LIMIT 3;
ALTER ROLE panel_app SET statement_timeout = '10s';
ALTER ROLE panel_app SET idle_in_transaction_session_timeout = '60s';
GRANT CONNECT ON DATABASE db_ipscentrodeorientacion TO panel_app;

-- panel_app solo es dueño de este esquema. No recibe permisos sobre public ni bi: no puede leer ni escribir
-- datos del bot, del backend ni de pacientes.
CREATE SCHEMA IF NOT EXISTS panel AUTHORIZATION panel_app;

-- El vigilante de soporte revisa que las migraciones del backend estén completas (solo lectura).
GRANT SELECT ON migrations TO panel_lectura;
