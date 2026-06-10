# Finding codes

Every `AuditFinding` carries a stable `code` so integrations can key on a machine identifier instead of matching the human `message` string (which may change between releases).

## Convention

`<factor-id>.<check>[.<variant>]` — lowercase kebab-case, dot-separated. `<check>` names the sub-check (e.g. `h1`, `meta-description`); `<variant>` distinguishes the outcomes of one check (e.g. `missing`, `multiple`, `single`). All branches of one check share the `<check>` segment. Codes are stable across releases and unique across the tool.

## Registry

### Structured Data (JSON-LD)

- `structured-data.json-ld.found`
- `structured-data.json-ld.missing`
- `structured-data.schema.found`
- `structured-data.schema.missing`
- `structured-data.schema-depth.strong`
- `structured-data.schema-depth.moderate`
- `structured-data.schema-depth.low`

### Content Depth

- `content-depth.word-count.strong`
- `content-depth.word-count.moderate`
- `content-depth.word-count.low`
- `content-depth.h1.single`
- `content-depth.h1.multiple`
- `content-depth.h1.missing`
- `content-depth.headings.strong`
- `content-depth.headings.moderate`
- `content-depth.headings.low`
- `content-depth.paragraphs.strong`
- `content-depth.paragraphs.moderate`
- `content-depth.paragraphs.low`
- `content-depth.lists.present`
- `content-depth.lists.none`

### AI Access Files (llms.txt, sitemap)

- `ai-access-files.content-negotiation.found`
- `ai-access-files.aux-resource.missing`
- `ai-access-files.aux-resource.timeout`
- `ai-access-files.aux-resource.unreachable`
- `ai-access-files.aux-resource.not-html`
- `ai-access-files.aux-resource.found`
- `ai-access-files.llms-txt.strong`
- `ai-access-files.llms-txt.short`
- `ai-access-files.llms-full-txt.strong`
- `ai-access-files.llms-full-txt.short`
- `ai-access-files.robots-txt.found`
- `ai-access-files.robots-txt.unreachable`
- `ai-access-files.robots-txt.missing`
- `ai-access-files.sitemap.found`
- `ai-access-files.sitemap.unreachable`
- `ai-access-files.sitemap.missing`
- `ai-access-files.llms-txt-link.found`
- `ai-access-files.llms-txt-link.missing`
- `ai-access-files.markdown-endpoint.found`
- `ai-access-files.markdown-endpoint.missing`

### E-E-A-T Signals

- `eeat-signals.author.credentialed`
- `eeat-signals.author.no-credentials`
- `eeat-signals.author.missing`
- `eeat-signals.author-meta.found`
- `eeat-signals.author-meta.missing`
- `eeat-signals.review.found`
- `eeat-signals.review.missing`
- `eeat-signals.trust-links.strong`
- `eeat-signals.trust-links.partial`
- `eeat-signals.trust-links.missing`
- `eeat-signals.organization.with-people`
- `eeat-signals.organization.no-people`
- `eeat-signals.organization.missing`

### FAQ Content

- `faq-content.faqpage.present`
- `faq-content.faqpage.missing`
- `faq-content.details.multiple`
- `faq-content.details.single`
- `faq-content.details.none`
- `faq-content.headings.multiple`
- `faq-content.headings.low`
- `faq-content.headings.missing`
- `faq-content.qa-pairs.multiple`
- `faq-content.qa-pairs.low`
- `faq-content.qa-pairs.none`

### Citations & Authority Signals

- `citations.external-links.strong`
- `citations.external-links.moderate`
- `citations.external-links.low`
- `citations.authoritative-domains.found`
- `citations.authoritative-domains.none`
- `citations.sameas.strong`
- `citations.sameas.moderate`
- `citations.sameas.missing`
- `citations.anchor-text.strong`
- `citations.anchor-text.moderate`
- `citations.anchor-text.low`

### Schema Completeness

- `schema-completeness.schema.none`
- `schema-completeness.local-business.strong`
- `schema-completeness.local-business.partial`
- `schema-completeness.local-business.low`
- `schema-completeness.faqpage.strong`
- `schema-completeness.faqpage.partial`
- `schema-completeness.faqpage.low`
- `schema-completeness.howto.strong`
- `schema-completeness.howto.partial`
- `schema-completeness.organization.strong`
- `schema-completeness.organization.partial`
- `schema-completeness.organization.low`
- `schema-completeness.schema-depth.moderate`
- `schema-completeness.schema-depth.low`

### Schema Validity

- `schema-validity.json-ld.none`
- `schema-validity.block.empty`
- `schema-validity.block.invalid`
- `schema-validity.singleton.duplicate`
- `schema-validity.block.valid`

### Entity Consistency

- `entity-consistency.name.missing`
- `entity-consistency.name.single`
- `entity-consistency.name.moderate`
- `entity-consistency.name.multiple`
- `entity-consistency.title.ok`
- `entity-consistency.title.long`
- `entity-consistency.canonical.present`
- `entity-consistency.canonical.missing`
- `entity-consistency.contact.ok`
- `entity-consistency.contact.partial`
- `entity-consistency.contact.missing`

### Content Freshness

- `content-freshness.date-modified.recent`
- `content-freshness.date-modified.moderate`
- `content-freshness.date-modified.stale`
- `content-freshness.date-modified.missing`
- `content-freshness.last-modified.recent`
- `content-freshness.last-modified.older`
- `content-freshness.last-modified.missing`
- `content-freshness.sitemap.recent`
- `content-freshness.sitemap.stale`
- `content-freshness.sitemap.no-match`
- `content-freshness.sitemap.timeout`
- `content-freshness.sitemap.unreachable`
- `content-freshness.sitemap.missing`
- `content-freshness.copyright.recent`
- `content-freshness.copyright.older`
- `content-freshness.copyright.missing`

### Content Extractability

- `content-extractability.content-ratio.strong`
- `content-extractability.content-ratio.moderate`
- `content-extractability.content-ratio.low`
- `content-extractability.citable-blocks.strong`
- `content-extractability.citable-blocks.moderate`
- `content-extractability.citable-blocks.missing`
- `content-extractability.paywall.found`
- `content-extractability.paywall.none`
- `content-extractability.ad-density.high`
- `content-extractability.ad-density.low`
- `content-extractability.ad-density.none`
- `content-extractability.direct-answer.strong`
- `content-extractability.direct-answer.moderate`
- `content-extractability.direct-answer.none`

### Definition Blocks

- `definition-blocks.headings.multiple`
- `definition-blocks.headings.single`
- `definition-blocks.headings.missing`
- `definition-blocks.lists.found`
- `definition-blocks.lists.none`
- `definition-blocks.schema.found`
- `definition-blocks.schema.missing`
- `definition-blocks.dl.found`
- `definition-blocks.dl.none`

### AI Crawler Access

- `ai-crawler-access.robots-txt.missing`
- `ai-crawler-access.robots-txt.unreachable`
- `ai-crawler-access.crawler.allowed`
- `ai-crawler-access.crawler.blocked`
- `ai-crawler-access.sitemap.found`
- `ai-crawler-access.content-signal.found`

### Named Entities

- `named-entities.brand-name.strong`
- `named-entities.brand-name.low`
- `named-entities.brand-name.missing`
- `named-entities.entity-name.missing`
- `named-entities.knows-about.present`
- `named-entities.knows-about.missing`
- `named-entities.proper-noun-density.strong`
- `named-entities.proper-noun-density.moderate`
- `named-entities.proper-noun-density.low`

### Technical SEO

- `technical-seo.h1.single`
- `technical-seo.h1.missing`
- `technical-seo.h1.multiple`
- `technical-seo.alt-text.none`
- `technical-seo.alt-text.ok`
- `technical-seo.alt-text.missing`
- `technical-seo.alt-text.empty`
- `technical-seo.meta-description.missing`
- `technical-seo.meta-description.short`
- `technical-seo.meta-description.long`
- `technical-seo.meta-description.present`
- `technical-seo.canonical.missing`
- `technical-seo.canonical.present`

### Snippet Eligibility

- `snippet-eligibility.directives.none`
- `snippet-eligibility.noindex.present`
- `snippet-eligibility.nosnippet.present`
- `snippet-eligibility.max-snippet.zero`
- `snippet-eligibility.max-snippet.low`
- `snippet-eligibility.noarchive.present`
- `snippet-eligibility.noimageindex.present`
- `snippet-eligibility.directives.not-restrictive`

### Geographic Signals (optional)

- `geographic-signals.localbusiness-schema.found`
- `geographic-signals.localbusiness-schema.missing`
- `geographic-signals.geo-coordinates.found`
- `geographic-signals.geo-coordinates.missing`
- `geographic-signals.postal-address.found`
- `geographic-signals.postal-address.missing`
- `geographic-signals.area-served.found`
- `geographic-signals.area-served.missing`
- `geographic-signals.geo-meta.found`
- `geographic-signals.geo-meta.missing`
- `geographic-signals.visible-location.found`
- `geographic-signals.visible-location.missing`

### Agent Skill Exposure (optional)

- `agent-skill-exposure.schema-action.well-formed`
- `agent-skill-exposure.schema-action.partial`
- `agent-skill-exposure.schema-action.missing`
- `agent-skill-exposure.mcp-discovery.found`
- `agent-skill-exposure.mcp-discovery.missing`
- `agent-skill-exposure.a2a-agent-card.found`
- `agent-skill-exposure.a2a-agent-card.missing`
- `agent-skill-exposure.openapi.found`
- `agent-skill-exposure.openapi.missing`
- `agent-skill-exposure.microdata.found`
- `agent-skill-exposure.microdata.missing`
- `agent-skill-exposure.forms.none`
- `agent-skill-exposure.forms.strong`
- `agent-skill-exposure.forms.partial`
- `agent-skill-exposure.forms.weak`

### Lighthouse (optional)

- `lighthouse.psi.unreachable`
- `lighthouse.category.missing`
- `lighthouse.category.score`
- `lighthouse.category.none`
