# syntax=docker/dockerfile:1
# NOTE: written without a Docker daemon available; never built in the authoring environment.

# ---- build the client ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY client client
RUN npm run build --workspace client

# ---- production-only dependencies ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace shared --workspace server --include-workspace-root=false

# ---- runtime ----
FROM node:22-slim AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA} \
    HOST=0.0.0.0 \
    PORT=3000 \
    CLIENT_DIR=/app/client/dist
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared shared
COPY server server
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown in server/src/index.ts)
CMD ["node", "server/src/index.ts"]
