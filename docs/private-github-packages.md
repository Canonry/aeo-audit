# Package Distribution

`@canonry/aeo-audit` is published as the same validated artifact in two places:

- Public npm (`https://registry.npmjs.org`) for normal CLI and library installs.
- GitHub Packages (`https://npm.pkg.github.com`) for Canonry infrastructure that
  intentionally installs from GitHub's registry.

## Public consumers

No registry mapping or package credential is required:

```bash
npm install @canonry/aeo-audit
```

```json
{
  "dependencies": {
    "@canonry/aeo-audit": "4.6.1"
  }
}
```

## GitHub Packages consumers

Consumers that intentionally use the GitHub Packages copy need:

- A committed scope mapping with no token:

  ```ini
  @canonry:registry=https://npm.pkg.github.com
  ```

- GitHub Packages read access granted to the consuming repository.
- CI permissions that include `contents: read` and `packages: read`.
- `NODE_AUTH_TOKEN` at install time. A repository with package access can use
  its workflow `GITHUB_TOKEN`; long-running hosts should use a dedicated
  read-only package token.

## Release contract

The release workflow validates the package once, creates one tarball, and fans
that artifact out to both registries. Public npm publishing uses GitHub OIDC
trusted publishing; GitHub Packages uses the workflow `GITHUB_TOKEN`. ClawHub
publishes only after both package registries succeed.

The public npm copy is the compatibility boundary for public Canonry releases.
Do not release a Canonry version that depends on a package version until that
exact version resolves from `https://registry.npmjs.org` without credentials.
