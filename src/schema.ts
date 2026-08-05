import { readFileSync } from 'node:fs'

/**
 * Version of the report JSON shape (`AuditReport` / `SitemapAuditReport`),
 * independent of the npm package version so agents can pin to a shape rather than
 * a release. Bump the minor for additive fields, the major for breaking changes.
 *
 * Lives in its own module (not `index.ts`) so report builders can read it without
 * importing the audit entry points — which test suites routinely mock.
 */
export const SCHEMA_VERSION = '3.4'

let cachedEngineVersion: string | null = null

/**
 * The npm package version of `@canonry/aeo-audit` at runtime, read once from the
 * package's own `package.json`. Embedded into report `compareMeta` so a stored
 * baseline records which engine produced it — scoring changes can ship under a
 * package version bump without changing `SCHEMA_VERSION`, so `compare` needs the
 * engine version to judge comparability. Resolves to `'0.0.0'` if the manifest
 * can't be read (it sits one directory above both `src/` and `dist/`).
 */
export function engineVersion(): string {
  if (cachedEngineVersion === null) {
    try {
      const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
        version?: string
      }
      cachedEngineVersion = manifest.version ?? '0.0.0'
    } catch {
      cachedEngineVersion = '0.0.0'
    }
  }
  return cachedEngineVersion
}
