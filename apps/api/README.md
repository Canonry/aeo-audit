# AEO Audit API

Private Fastify service exposing the public, key-gated AEO audit API. It consumes
the workspace `@ainyc/aeo-audit` engine directly and stores only agency/day usage
in `AEO_AUDIT_DATA_DIR/usage.db`.

## Local development

The bridge URL and a 32-character service secret are required even when the
platform audit-key flag is dark:

```bash
NODE_ENV=development \
FLEET_AUDIT_BRIDGE_URL=http://127.0.0.1:4600 \
FLEET_AUDIT_SVC_SECRET=replace-with-at-least-32-characters \
AEO_AUDIT_DATA_DIR=./data \
pnpm --filter @ainyc/aeo-audit-api dev
```

Run `pnpm run build` at the repository root before the focused service build;
the service runtime consumes the engine package's `dist/` export. Root
`pnpm test`, `pnpm run typecheck`, and `pnpm run lint` aggregate both packages.

## Agent-node deployment

`ops/deploy-audit-api.sh` builds from repository root, smokes a candidate on
`127.0.0.1:4701` with scratch SQLite, then swaps the serving container on
`127.0.0.1:4700`. The container deliberately uses Docker host networking:
`FLEET_AUDIT_BRIDGE_URL=http://127.0.0.1:4600` then reaches the loopback-only
platform process. The production override `AEO_AUDIT_BIND=127.0.0.1` ensures the
audit service is also loopback-only and Caddy remains its sole public ingress.

Create `/home/arberx/fleet-data/aeo-audit.env` as mode 0600 with at least:

```dotenv
NODE_ENV=production
FLEET_AUDIT_BRIDGE_URL=http://127.0.0.1:4600
FLEET_AUDIT_SVC_SECRET=the-same-generated-secret-as-the-platform
AUDIT_HOST_REQUEST_TIMEOUT_MS=300000
```

Rollback uses the image recorded before the last successful swap:

```bash
ops/deploy-audit-api.sh --rollback
```
