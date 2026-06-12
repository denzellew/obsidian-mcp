# ---- ob: install obsidian-headless where a build toolchain exists ----------
FROM node:24.16.0 AS ob
RUN npm install -g --prefix /opt/ob obsidian-headless

# ---- app: build CSS + bundle the server with bun ----------------------------
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx @tailwindcss/cli -i styles/app.css -o public/app.css --minify \
 && bun build src/server.ts --target=bun --outdir=dist \
 && mkdir -p dist/migrations && cp src/db/migrations/*.sql dist/migrations/

# ---- runtime -----------------------------------------------------------------
FROM node:24.16.0-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ob /opt/ob /opt/ob
ENV PATH="/opt/ob/bin:${PATH}" \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "dist/server.js"]
