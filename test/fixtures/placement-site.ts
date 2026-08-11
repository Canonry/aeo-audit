/**
 * A template site shaped like the production case that motivated link-placement
 * capture, on canonry.ai.
 *
 * The primary nav and an in-prose editorial link both point at
 * `/chatgpt-seo-agency` with the anchor text "ChatGPT SEO Agency", because good
 * anchor text reuses the destination's canonical name — which is the same name
 * the nav uses. The nav pair appears on 7 of these 8 pages, so a consumer that
 * classifies template links by ubiquity marks the pair chrome and hides the
 * editorial link with it. Only DOM position separates them.
 *
 * Every landmark links to a target no other landmark links to, so each
 * assertion isolates exactly one placement.
 */

const chrome = `
<header>
  <nav aria-label="Primary">
    <a href="/">Canonry</a>
    <a href="/chatgpt-seo-agency">ChatGPT SEO Agency</a>
    <a href="/pricing">Pricing</a>
  </nav>
</header>`

const footer = `
<footer>
  <a href="/terms">Terms</a>
</footer>`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${title} on the Canonry placement fixture site.">
</head><body>${chrome}
${body}
${footer}
</body></html>`
}

function simplePage(title: string, heading: string): string {
  return page(title, `<main><h1>${heading}</h1><p>${heading} for teams that want to be cited by AI answer engines.</p></main>`)
}

/** Path to HTML for every page of the fixture site. Links are root-relative. */
export const placementSitePages: Readonly<Record<string, string>> = {
  '/': page('Canonry | AI visibility', `
<main>
  <h1>Be the answer, not the tenth blue link</h1>
  <p>Read <a href="/blog/how-to-rank-on-chatgpt">how to rank on ChatGPT</a> to see how answer engines choose sources.</p>
  <p>Our older write-up still lives on the <a href="/legacy-page">legacy page</a>.</p>
</main>`),

  // The motivating page. Its nav link and its prose link share a target AND an
  // anchor text, and differ only by where they sit.
  '/blog/how-to-rank-on-chatgpt': page('How to rank on ChatGPT', `
<main>
  <nav aria-label="On this page">
    <a href="/blog/citations">Citations</a>
  </nav>
  <article>
    <h1>How to rank on ChatGPT</h1>
    <p>Answer engines cite pages that answer a question directly. If you would rather not run the
    program in-house, a <a href="/chatgpt-seo-agency">ChatGPT SEO Agency</a> can own the measurement
    loop for you.</p>
  </article>
  <aside>
    <h2>Related</h2>
    <a href="/glossary">Glossary</a>
  </aside>
</main>`),

  '/chatgpt-seo-agency': simplePage('ChatGPT SEO Agency', 'ChatGPT SEO Agency'),
  '/pricing': simplePage('Pricing', 'Pricing'),
  '/terms': simplePage('Terms', 'Terms of service'),
  '/blog/citations': simplePage('Citations', 'How citations work'),
  '/glossary': simplePage('Glossary', 'AEO glossary'),

  // No landmark anywhere. A consumer that guessed from class names would call
  // these chrome; the crawler must report `unknown` and let the consumer decide.
  '/legacy-page': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy page</title>
<meta name="description" content="A legacy page built before HTML landmarks, on the Canonry placement fixture site.">
</head><body>
<div class="site-nav"><a href="/pricing">Pricing</a></div>
<div class="content"><h1>Legacy page</h1><p>An older <a href="/chatgpt-seo-agency">ChatGPT SEO Agency</a> write-up.</p></div>
<div class="footer"><a href="/terms">Terms</a></div>
</body></html>`,
}
