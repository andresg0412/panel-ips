# panel-ips

Panel web de solo lectura para que la gerencia del Centro de Orientación vea campañas, agenda, chatbot y
lista de espera. Lee la base de datos de `proyecto-ips` (esquema `bi`) con un rol que no puede escribir.

Plan y decisiones: `proyecto-ips/docs/features/2026-10-04-panel-cliente-plan.md`.

## Arquitectura

```
https://panel-ips.zentrixsolucionesdigitales.com
  → nginx del droplet (HTTPS + usuario/contraseña por persona)  /etc/nginx/sites-available/panel-ips
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
# Para probar roles y niveles, con una BD local que tenga el esquema panel:
#   DATABASE_URL_APP=postgres://panel_app:<pass>@... PANEL_USUARIO_DEV=soporte VIGILANTE_BACKEND_URL= VIGILANTE_SCRAPER_URL=
npm run dev:web        # http://localhost:5173
```

## Despliegue

1. `npm run build` aquí (no en el droplet).
2. Copiar `dist/`, `package*.json`, `Dockerfile`, `docker-compose.yml` a `/opt/proyectos/panel-ips`.
3. En el droplet: `docker compose build && docker compose up -d`.

Lo hace la skill `desplegar-droplet` de proyecto-ips (sección "Panel").

## Usuarios

Cada persona necesita dos cosas: usuario y contraseña en nginx, y un rol en la consola de soporte (Usuarios y
roles). Sin rol, al entrar ve un aviso de que no tiene acceso.

`/etc/nginx/.htpasswd-panel-ips`, una línea por persona. Agregar o cambiar contraseña:
`printf 'usuario:%s\n' "$(openssl passwd -apr1 'contraseña')" >> /etc/nginx/.htpasswd-panel-ips`
(para cambiar, borrar antes la línea vieja). Quitar acceso: borrar la línea. No requiere recargar nginx.
