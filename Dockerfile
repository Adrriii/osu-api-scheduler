# syntax=docker/dockerfile:1

# ---- build the dashboard -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web/ web/
RUN npm run build --workspace web

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
# tsx is needed at runtime: the server is run from TypeScript source rather
# than a build step, which keeps the image honest about what it is running.
RUN npm ci --omit=dev --workspace server --include-workspace-root \
 && npm i -w server tsx@^4.19.0 \
 && npm cache clean --force

COPY server/ server/
COPY --from=web /app/web/dist web/dist

# State (metrics db, token, secrets, pace file) lives on a volume so it
# survives image upgrades.
ENV SCHEDULER_STATE_DIR=/data \
    SCHEDULER_WEB_ROOT=/app/web/dist \
    SCHEDULER_HOST=0.0.0.0 \
    SCHEDULER_PORT=7654
RUN mkdir -p /data && addgroup -g 10001 app && adduser -u 10001 -G app -D app \
 && chown -R app:app /data /app
USER app
VOLUME ["/data"]
EXPOSE 7654

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SCHEDULER_PORT||7654)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "server/src/index.ts"]
