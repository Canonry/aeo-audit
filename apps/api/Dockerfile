FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm run build && pnpm --filter @ainyc/aeo-audit-api run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    AEO_AUDIT_BIND=0.0.0.0 \
    AEO_AUDIT_DATA_DIR=/data
WORKDIR /app

RUN groupadd --gid 10001 audit-api \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin audit-api

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
