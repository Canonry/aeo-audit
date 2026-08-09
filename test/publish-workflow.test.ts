import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  publishConfig?: { registry?: string }
}

const workflow = readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8',
)

describe('release workflow', () => {
  it('publishes the same package to GitHub Packages and public npm', () => {
    expect(packageJson.name).toBe('@canonry/aeo-audit')
    expect(packageJson.publishConfig?.registry).toBe(
      'https://npm.pkg.github.com',
    )

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain(
      'npm publish release/package.tgz --registry=https://npm.pkg.github.com',
    )
    expect(workflow).toContain(
      'npm publish release/package.tgz --registry=https://registry.npmjs.org --access public',
    )
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(workflow).toContain('npm install --global npm@11.5.1')
  })

  it('packs once and fans out only after validation succeeds', () => {
    expect(workflow).toContain('name: Pack release artifact')
    expect(workflow).toContain('name: release-package')
    expect(workflow).toContain('needs: prepare')
    expect(workflow).toContain('needs: [prepare, publish-github, publish-npm]')
  })

  it('serializes main-only releases and verifies registry integrity on retries', () => {
    expect(workflow).toContain('group: package-release')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow.match(/dist\.integrity/g)).toHaveLength(2)
    expect(workflow.match(/createHash\('sha512'\)/g)).toHaveLength(2)
    expect(
      workflow.match(/Registry artifact does not match release\/package\.tgz/g),
    ).toHaveLength(2)
  })
})
