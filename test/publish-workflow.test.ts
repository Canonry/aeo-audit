import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  version: string
  publishConfig?: { access?: string; registry?: string }
}

const workflow = readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8',
)
const changelog = readFileSync(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8',
)

describe('release workflow', () => {
  it('publishes the preferred package and compatibility package to public npm', () => {
    expect(packageJson.name).toBe('@canonry/aeo-audit')
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(changelog).toContain(`## ${packageJson.version} (`)
    expect(packageJson.publishConfig?.registry).toBe(
      'https://registry.npmjs.org',
    )
    expect(packageJson.publishConfig?.access).toBe('public')

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain(
      'publish_package "@canonry/aeo-audit" "release/canonry-package.tgz"',
    )
    expect(workflow).toContain(
      'publish_package "@ainyc/aeo-audit" "release/ainyc-package.tgz"',
    )
    expect(workflow.match(/npm publish "\.\/\$TARBALL" --registry=https:\/\/registry\.npmjs\.org --access public --provenance/g)).toHaveLength(1)
    expect(workflow).toContain('npm install --global npm@11.5.1')
    expect(workflow).not.toContain('npm.pkg.github.com')
    expect(workflow).not.toContain('secrets.GITHUB_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  it('pins npm before packing one build into the exact two package artifacts', () => {
    const npmPin = 'npm install --global npm@11.5.1'
    const packStep = 'name: Pack release artifacts'

    expect(workflow).toContain(packStep)
    expect(workflow.indexOf(npmPin)).toBeLessThan(workflow.indexOf(packStep))
    expect(workflow).toContain('npm pack --ignore-scripts --pack-destination release')
    expect(workflow).toContain('mv release/*.tgz release/canonry-package.tgz')
    expect(workflow).toContain('release/canonry-package.tgz')
    expect(workflow).toContain('release/ainyc-package.tgz')
    expect(workflow).toContain("p.name = '@ainyc/aeo-audit'")
    expect(workflow).toContain('mv release/ainyc-aeo-audit-*.tgz release/ainyc-package.tgz')
    expect(workflow).toContain('diff -qr --exclude=package.json')
    expect(workflow).toContain('assert.deepStrictEqual(canonryRest, ainycRest)')
    expect(workflow).toContain('name: release-packages')
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
      workflow.match(/Registry artifact does not match \$TARBALL/g),
    ).toHaveLength(1)
  })

  it('publishes when either the package name or version changes', () => {
    expect(workflow).toContain("p.name + '@' + p.version")
    expect(workflow).toContain('"$PREV_ID" != "$CURR_ID"')
  })

  it('allows an explicit manual retry without changing package identity', () => {
    expect(workflow).toContain('EVENT_NAME: ${{ github.event_name }}')
    expect(workflow).toContain('"$EVENT_NAME" = "workflow_dispatch"')
  })

  it('retries after a release-workflow fix without changing package identity', () => {
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('BEFORE_SHA: ${{ github.event.before }}')
    expect(workflow).toContain('BASE="$BEFORE_SHA"')
    expect(workflow).toContain(
      'git diff --quiet "$BASE" HEAD -- .github/workflows/publish.yml',
    )
    expect(workflow).toContain('"$WORKFLOW_CHANGED" = "true"')
  })

  it('treats only an explicit registry 404 as an unpublished version', () => {
    expect(workflow).toContain('REGISTRY_STDOUT=$(mktemp)')
    expect(workflow).toContain('REGISTRY_STDERR=$(mktemp)')
    expect(workflow).toContain('REGISTRY_STATUS=$?')
    expect(workflow).toContain("grep -q 'E404' \"$REGISTRY_STDERR\"")
    expect(workflow).toContain("grep -Eq '^sha512-[A-Za-z0-9+/]+={0,2}$'")
    expect(workflow).toContain('exit "$REGISTRY_STATUS"')
    expect(workflow).not.toMatch(/npm view .*\|\| true/)
  })

  it('makes each retry fail closed against the matching artifact and publishes Canonry first', () => {
    expect(workflow).toContain('ACTUAL_VERSION=$(tar -xOf "$TARBALL" package/package.json')
    expect(workflow).toContain('expected $PACKAGE_NAME@$VERSION')
    expect(workflow.indexOf('publish_package "@canonry/aeo-audit"')).toBeLessThan(
      workflow.indexOf('publish_package "@ainyc/aeo-audit"'),
    )
    expect(workflow).toContain('Registry artifact does not match $TARBALL')
    expect(workflow).toContain('return')
  })
})
