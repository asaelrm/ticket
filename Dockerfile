# ============================================================================
# Ticket - Imagen multi-etapa (frontend + backend en un solo contenedor)
# ============================================================================

# ---------------------------------------------------------------------------
# Etapa 1: dependencias de producción del backend
# ---------------------------------------------------------------------------
FROM node:24-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---------------------------------------------------------------------------
# Etapa 2: build del frontend (Vite)
# ---------------------------------------------------------------------------
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci || npm install
COPY frontend ./
RUN npm run build

# ---------------------------------------------------------------------------
# Etapa 3: runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app/backend

COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/package*.json ./
COPY backend ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# Directorios de datos persistentes
RUN mkdir -p /app/backend/data /app/backend/uploads \
    && chown -R node:node /app/backend

USER node
EXPOSE 4000
CMD ["node", "src/server.js"]