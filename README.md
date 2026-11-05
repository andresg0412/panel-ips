# panel-ips

Panel web de solo lectura para que la gerencia del Centro de Orientación vea campañas, agenda, chatbot y
lista de espera. Lee la base de datos de `proyecto-ips` (esquema `bi`) con un rol que no puede escribir.

Plan y decisiones: `proyecto-ips/docs/features/2026-10-04-panel-cliente-plan.md`.

## Arquitectura

```
https://panel-ips.zentrixsolucionesdigitales.com
  → nginx del droplet (HTTPS, límite de intentos en el login)  /etc/nginx/sites-available/panel-ips
  → 127.0.0.1:8100  contenedor panel-ips (Fastify: API /api/* + frontend compilado)
  → shared_network → ips-centro-orientacion-db-1:5432, rol panel_lectura (solo SELECT, 15 s por consulta)
```

No toca el backend, el bot, PM2 ni el sitio `default` de nginx.

## Roles, niveles y consola de soporte (Etapa 1)

Plan: `proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md`.

- **Dos roles de Postgres.** `panel_lectura` lee los datos (`bi` y unas tablas de `public`), sin escribir nada.
  `panel_app` solo es dueño del esquema `panel`, donde viven la licencia, los usuarios y sus roles, las alertas de
  soporte, la actividad y los incidentes de datos. Las tablas de `panel` las crea el propio panel al arrancar
  (`server/esquema.ts`).
- **Quién ve qué** se define en un solo archivo, `server/funciones.ts`: niveles (Básico, Intermedio, Full), roles
  (Dirección, Operación, Analista, Relación con pacientes, Profesional, Soporte), funciones y endpoints. Lo aplica
  `server/acceso.ts` en cada petición; el frontend solo pinta candados. Un endpoint nuevo que no esté en
  `ENDPOINTS` se rechaza.
- Las partes de una respuesta que dependen del nivel se recortan en `server/recortes.ts`.
- **Consola de soporte** (`#/soporte`, usuario `soporte`): alertas técnicas del vigilante (`server/vigilante.ts`,
  cada 5 min), cambio de plan, vista previa como otro plan o rol, usuarios y roles, actividad e incidentes.
- **Sin `DATABASE_URL_APP`** el panel funciona como antes de la Etapa 1 (todos como Dirección, plan Full, sin consola).

## Desarrollo local

```bash
npm install
# Túnel a la BD de producción con el rol de solo lectura:
ssh -N -L 15434:localhost:5434 ips-droplet
DATABASE_URL=postgres://panel_lectura:<pass>@localhost:15434/db_ipscentrodeorientacion npm run dev:server
# Con el login propio hacen falta DATABASE_URL_APP y PANEL_AUTH_SECRET (openssl rand -base64 32). Para el correo de
# recuperación en local use EMAIL_PROVEEDOR=memoria. Los usuarios se crean en la consola de soporte; para el primero,
# acceso-emergencia (ver Operación). Para probar con la identidad de nginx (solo transición): PANEL_AUTH_MODO=nginx
# y PANEL_USUARIO_DEV=soporte.
#   DATABASE_URL_APP=postgres://panel_app:<pass>@... VIGILANTE_BACKEND_URL= VIGILANTE_SCRAPER_URL=
npm run dev:web        # http://localhost:5173
```

## Despliegue

1. `npm run build` aquí (no en el droplet).
2. Copiar `dist/`, `package*.json`, `Dockerfile`, `docker-compose.yml` a `/opt/proyectos/panel-ips`.
3. En el droplet: `docker compose build && docker compose up -d`.

Lo hace la skill `desplegar-droplet` de proyecto-ips (sección "Panel").

## Login propio y usuarios

Especificación: `proyecto-ips/docs/features/2026-11-04-panel-login-autenticacion.md`.

La autenticación ya no la hace nginx (Basic Auth): la hace el propio panel, con sesiones.

- **Entrada:** usuario **o correo** y contraseña. Cookie de sesión `HttpOnly` (`__Host-panel_sesion` en producción),
  `SameSite=Lax`. En la base solo se guarda el SHA-256 del token. Sesión normal: 60 min de inactividad y 12 h máximo;
  "Mantener la sesión iniciada": 24 h de inactividad y 7 días máximo. Las consultas automáticas del navegador
  (tableros, alertas, chat) llevan `X-Panel-Sondeo: 1` y **no** cuentan como actividad.
- **Contraseñas:** `scrypt` (N=2^15, r=8, p=3), mínimo 8 caracteres con minúscula, mayúscula, número y carácter
  especial, sin claves comunes ni el usuario, sin reutilizar la actual ni las 3 anteriores. El panel nunca guarda la
  contraseña en el navegador.
- **Recuperación:** código de 6 dígitos por correo (Resend), 15 minutos, un solo uso, 5 intentos.
- **Dentro del panel:** "Mi cuenta" (`#/cuenta`): cambiar contraseña y ver o cerrar sesiones. Para lanzar envíos a
  pacientes se vuelve a pedir la contraseña (vale 10 minutos).
- **Soporte** (`#/soporte`, Usuarios): crear usuarios, cargar su correo, **generar una contraseña temporal** (se
  muestra una vez, vence en 24 h y obliga a cambiarla), desbloquear cuentas, cerrar sesiones. La pestaña **Accesos**
  lista los eventos de autenticación (retención de 365 días).
- **Primer acceso de una persona:** soporte genera una temporal y se la entrega por un canal distinto; o, si ya tiene
  correo cargado, usa "¿Olvidó su contraseña?".

### Modos (`PANEL_AUTH_MODO`)

| Valor | Uso |
|---|---|
| `sesion` (por defecto) | Identidad solo desde la cookie. **La cabecera `X-Remote-User` se ignora por completo.** |
| `nginx` | Solo la transición del despliegue: identidad por `X-Remote-User` como antes. `/api/auth/*` responde 404. |

Una variable ausente es `sesion`; un valor inválido, o faltar `DATABASE_URL_APP` o `PANEL_AUTH_SECRET`, impide
arrancar. Un fallo al preparar el esquema `panel` también detiene el proceso.

### Operación

Dentro del contenedor (los scripts compilan a `dist/server/scripts/`):

```bash
# Contraseña temporal de emergencia (se imprime una vez; vence en 24 h):
docker exec panel-ips node dist/server/scripts/acceso-emergencia.js soporte
# Sesión de soporte de 5 minutos para verificar un despliegue (imprime el valor de la cookie):
C=$(docker exec panel-ips node dist/server/scripts/sesion-verificacion.js)
curl -H "Cookie: __Host-panel_sesion=$C" 127.0.0.1:8100/api/yo
```

### Pruebas

```bash
npm run typecheck && npm run build
npm run test:niveles && npm run test:ux
# Necesitan una base DESECHABLE cuyo nombre termine en _test (recrean el esquema `panel` y roles de prueba):
TEST_ADMIN_URL=postgres://admin:...@127.0.0.1:5437/auth_test npm run test:auth
TEST_ADMIN_URL=postgres://admin:...@127.0.0.1:5437/historial_test npm run test:conversaciones
```

`test:niveles` en vivo acepta `PANEL_COOKIE` (la cookie completa, `nombre=valor`, de una sesión de soporte).
