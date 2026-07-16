# Private GitHub Packages Release

`@canonry/aeo-audit` is the private engine package for hosted Canonry services.
It is not a drop-in public-registry replacement until each consumer has GitHub
Packages read access and install-time authentication.

## Consumer dependency

```json
{
  "dependencies": {
    "@canonry/aeo-audit": "4.3.0"
  }
}
```

Equivalent dependency string:

```yaml
@canonry/aeo-audit: 4.3.0
```

## Required consumer setup

Each consuming private repository needs:

- A committed `.npmrc` with only the registry mapping:

  ```ini
  @canonry:registry=https://npm.pkg.github.com
  ```

- GitHub Packages read access granted to that repository on the package.
- CI permissions that include:

  ```yaml
  permissions:
    contents: read
    packages: read
  ```

- `NODE_AUTH_TOKEN` supplied at install time. In GitHub Actions this can be the
  workflow `GITHUB_TOKEN` after the repository has package read access. On
  long-running hosts such as agent-node, use a dedicated read-only package token.

## Compatibility gate

Do not make the existing public `@ainyc/aeo-audit` package private or
unavailable while any production consumer still depends on it. Current consumers
must either keep installing the public compatibility package or land their own
dependency/authentication PRs before this private package is published for
production use.

The publish workflow is manually dispatched for that reason: merge this engine
change first, wait for consumer access and dependency PRs to be ready, then run
the publish workflow on `main`.
