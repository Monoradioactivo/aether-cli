# aether-cli Maintenance

This document captures repository settings, operational procedures, and conventions that live outside of code. Update it
whenever any of these change.

## Branch protection

`main` is the only long-lived branch. All changes land via pull request.

Configure via GitHub UI: **Settings → Branches → Branch protection rules → Add rule**.

Rule pattern: `main`

- Require a pull request before merging
  - Require approvals: 0 (solo maintainer)
  - Dismiss stale pull request approvals when new commits are pushed: enabled
- Require status checks to pass before merging
  - Require branches to be up to date before merging: enabled
  - Required status checks:
    - `Branch name policy`
    - `Node 18`
    - `Node 20`
    - `Node 22`
- Require conversation resolution before merging: enabled
- Do not allow bypassing the above settings: enabled
- Allow force pushes: disabled
- Allow deletions: disabled

When collaborators are added, raise required approvals to 1.

## Branch naming policy

Branches must start with one of:

- `feat/` — new feature
- `fix/` — bug fix
- `refactor/` — internal refactor with no behavior change
- `chore/` — tooling, deps, infrastructure
- `docs/` — documentation only

Dependabot branches (`dependabot/*`) are exempt; the CI policy job skips them.

## Repository secrets

| Secret   | Purpose                                                     |
|----------|-------------------------------------------------------------|
| _(none)_ | npm publish uses OIDC trusted publishing, not stored tokens |

## npm trusted publisher

Configured at: **npmjs.com → @aetherpush/cli → Settings → Trusted Publisher**

- Provider: GitHub Actions
- Organization/user: `Monoradioactivo`
- Repository: `aether-cli`
- Workflow filename: `release.yml`
- Environment: (none)

If the workflow filename changes, this configuration must be updated. Otherwise publishes will fail with HTTP 404 from
npm.

## Bootstrap publish (one-time, manual)

Trusted publishing requires the package to exist on npm before it can be configured. The first publish is manual from
the maintainer's machine:

```sh
npm login
npm version 0.1.0-alpha.0 --no-git-tag-version
npm run build
npm publish --access public --tag alpha
```

After the package appears on `npmjs.com/package/@aetherpush/cli`, configure the trusted publisher (see above). All
subsequent releases use the workflow.

## Release process

Releases are triggered by pushing a tag matching `v*.*.*`. From `main`:

```sh
npm version patch
git push --follow-tags
```

Use `--preid=beta` for pre-releases:

```sh
npm version prerelease --preid=beta
git push --follow-tags
```

The `release.yml` workflow:

1. Detects whether the tag contains `-beta.` (or similar pre-release marker)
2. Builds and publishes with `--tag beta` for pre-releases, `--tag latest` for stable
3. Generates a provenance attestation automatically (npm requirement for OIDC)

## Dependabot

Configured in `.github/dependabot.yml`. Weekly bumps every Monday 06:00 CDMX, grouped by:

- `@types/*` packages
- ESLint + `@typescript-eslint/*`
- Testing libs (`sinon`, `mocha`, `superagent-mock`)
- All other production dependency minor/patch updates

Major version bumps land as individual PRs for manual review.

## CI

Configured in `.github/workflows/ci.yml`. Runs on pull requests to `main` and pushes to `main`.

Jobs:

- `Branch name policy` — enforces branch prefix convention
- `Node 18` / `Node 20` / `Node 22` — install, build, typecheck

Test infrastructure will be wired up in phase 6A-4.6. Lint config improvements (extending `recommended`, switching to
TS-aware `no-unused-vars`) tracked as backlog.

## Required reviewers

Currently solo maintainer. When collaborators are added:

1. Add them via **Settings → Collaborators**
2. Update branch protection to require 1 approval
3. Update this document
