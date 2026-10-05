-- Rol de solo lectura para el panel. Se ejecuta una vez, como el usuario admin de Postgres.
-- No modifica ninguna tabla ni vista existente: solo crea el rol y le da permisos de lectura.
-- Uso: psql -v pass="'<password>'" -f crear-rol.sql

CREATE ROLE panel_lectura LOGIN PASSWORD :pass CONNECTION LIMIT 5;
ALTER ROLE panel_lectura SET default_transaction_read_only = on;
ALTER ROLE panel_lectura SET statement_timeout = '15s';
ALTER ROLE panel_lectura SET idle_in_transaction_session_timeout = '60s';

GRANT CONNECT ON DATABASE db_ipscentrodeorientacion TO panel_lectura;

-- Capa de reportería (migración 030). Las vistas se ejecutan con los permisos de su dueño,
-- así que no hace falta dar acceso a las tablas base (agenda, pacientes, chat_stats...).
GRANT USAGE ON SCHEMA bi TO panel_lectura;
GRANT SELECT ON ALL TABLES IN SCHEMA bi TO panel_lectura;
ALTER DEFAULT PRIVILEGES IN SCHEMA bi GRANT SELECT ON TABLES TO panel_lectura;

-- Tablas de lista de espera que todavía no tienen vista en bi (ninguna tiene datos clínicos).
GRANT USAGE ON SCHEMA public TO panel_lectura;
GRANT SELECT ON lista_espera, cupos_liberados, ofertas_cupo,
                invitaciones_lista_espera, ejecuciones_invitacion_lista_espera TO panel_lectura;

-- Oleada 2 (2026-10-04): ocupación de agenda (horarios vigentes) y ejecuciones de campañas
-- (filas resumen EJECUCION_* que bi.fact_eventos excluye; el resto del contenido ya es visible en bi).
GRANT SELECT ON horariosequipo, chat_stats TO panel_lectura;
