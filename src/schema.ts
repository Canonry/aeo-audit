/**
 * Version of the report JSON shape (`AuditReport` / `SitemapAuditReport`),
 * independent of the npm package version so agents can pin to a shape rather than
 * a release. Bump the minor for additive fields, the major for breaking changes.
 *
 * Lives in its own module (not `index.ts`) so report builders can read it without
 * importing the audit entry points — which test suites routinely mock.
 */
export const SCHEMA_VERSION = '2.0'
