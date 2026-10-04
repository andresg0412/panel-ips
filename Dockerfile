# Imagen solo de ejecución. `dist/` se compila antes (npm run build) fuera del droplet,
# para no gastar RAM/CPU del servidor que atiende al bot. Ver README.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dist ./dist
USER node
EXPOSE 8100
CMD ["node", "dist/server/index.js"]
