import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  publishConfig?: { access?: string; registry?: string }
}

const workflow = readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8',
)

describe('release workflow', () => {
  it('publishes the canonical package to public npm only', () => {
    expect(packageJson.name).toBe('@ainyc/aeo-audit')
    expect(packageJson.publishConfig?.registry).toBe(
      'https://registry.npmjs.org',
    )
    expect(packageJson.publishConfig?.access).toBe('public')

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain(
      'npm publish release/package.tgz --registry=https://registry.npmjs.org --access public --provenance',
    )
    expect(workflow).toContain('npm install --global npm@11.5.1')
    expect(workflow).not.toContain('npm.pkg.github.com')
    expect(workflow).not.toContain('secrets.GITHUB_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  it('packs once and publishes only after validation succeeds', () => {
    expect(workflow).toContain('name: Pack release artifact')
    expect(workflow).toContain('name: release-package')
    expect(workflow).toContain('needs: prepare')
    expect(workflow).toContain('needs: [prepare, publish-npm]')
  })

  it('serializes main-only releases and verifies registry integrity on retries', () => {
    expect(workflow).toContain('group: package-release')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow.match(/dist\.integrity/g)).toHaveLength(1)
    expect(workflow.match(/createHash\('sha512'\)/g)).toHaveLength(1)
    expect(
      workflow.match(/Registry artifact does not match release\/package\.tgz/g),
    ).toHaveLength(1)
  })

  it('publishes when either the package name or version changes', () => {
    expect(workflow).toContain("p.name + '@' + p.version")
    expect(workflow).toContain('if [ "$PREV_ID" != "$CURR_ID" ]; then')
  })
})
