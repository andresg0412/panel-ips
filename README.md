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

## Desarrollo local

```bash
npm install
# Túnel a la BD de producción con el rol de solo lectura:
ssh -N -L 15434:localhost:5434 ips-droplet
DATABASE_URL=postgres://panel_lectura:<pass>@localhost:15434/db_ipscentrodeorientacion npm run dev:server
npm run dev:web        # http://localhost:5173
```

## Despliegue

1. `npm run build` aquí (no en el droplet).
2. Copiar `dist/`, `package*.json`, `Dockerfile`, `docker-compose.yml` a `/opt/proyectos/panel-ips`.
3. En el droplet: `docker compose build && docker compose up -d`.

Lo hace la skill `desplegar-droplet` de proyecto-ips (sección "Panel").

## Usuarios

`/etc/nginx/.htpasswd-panel-ips`, una línea por persona. Agregar o cambiar contraseña:
`printf 'usuario:%s\n' "$(openssl passwd -apr1 'contraseña')" >> /etc/nginx/.htpasswd-panel-ips`
(para cambiar, borrar antes la línea vieja). Quitar acceso: borrar la línea. No requiere recargar nginx.
