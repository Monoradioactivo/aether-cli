# aether-cli Maintenance

This document captures repository settings, operational procedures, and conventions that live outside of code. Update it
whenever any of these change.

## Repository configuration

Configure via GitHub UI: **Settings → General → Pull Requests**.

- Allow merge commits: disabled
- Allow squash merging: enabled
- Allow rebase merging: disabled (squash keeps history linear)
- Allow auto-merge: enabled
- Automatically delete head branches: enabled

Configure via GitHub UI: **Settings → Actions → General → Workflow permissions**.

- Default workflow permissions: Read and write
- Allow GitHub Actions to create and approve pull requests: enabled (required for the Dependabot auto-approve workflow)

## Branch protection

`main` is the only long-lived branch. All changes land via pull request. Protection is configured via the **Rulesets** system (not classic Branch protection rules).

Configure via GitHub UI: **Settings → Rules → Rulesets → "Main Ruleset"**.

Target: `main`

- Require a pull request before merging
  - Required approvals: **1**
  - Dismiss stale pull request approvals when new commits are pushed: enabled
- Require status checks to pass before merging
  - Require branches to be up to date before merging: enabled
  - Required status checks:
    - `Branch name policy`
    - `Node 18`
    - `Node 20`
    - `Node 22`
    - `GitHub Advanced Security / CodeQL` (added when CodeQL Default Setup was enabled)
- Require conversation resolution before merging: enabled
- Do not allow bypassing the above settings: enabled
- Allow force pushes: disabled
- Allow deletions: disabled

Dependabot PRs satisfy the approval requirement automatically via `.github/workflows/dependabot-auto-approve.yml` — but
only for `semver-patch` and `semver-minor` updates. Major bumps require manual review.

## Branch naming policy

Branches must start with one of:

- `feat/` — new feature
- `fix/` — bug fix
- `refactor/` — internal refactor with no behavior change
- `chore/` — tooling, deps, infrastructure
- `docs/` — documentation only

Dependabot branches (`dependabot/*`) are exempt; the CI policy job early-exits for them.

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

### Auto-approval policy

The `dependabot-auto-approve.yml` workflow auto-approves Dependabot PRs whose update-type is `semver-patch` or
`semver-minor`. Major bumps are NOT auto-approved and require manual review — this is intentional protection against
supply chain attacks where a compromised dependency publishes a backdoored version that passes CI.

### Ignored majors

The `ignore` block in `dependabot.yml` skips major bumps for packages we have intentionally decided to stay behind on:

- `eslint` — v9 is ESM-only flat-config-only, incompatible with current CommonJS setup
- `chalk` — v5 is ESM-only
- `prettier` — v3 has breaking format changes (cosmetic only, not worth the diff churn)
- `yargs` — v18 has breaking changes in `.argv` parsing used across the CLI
- `rimraf` — v4+ migrated to Promise-based API; current code uses `rimraf.sync` in `script/utils/file-utils.ts`
- `superagent` — used heavily in `script/management-sdk.ts`; major migration planned in phase 6A-4.3

To remove an ignore (e.g., once the underlying code is migrated), delete the entry and Dependabot will re-evaluate on
its next run.

## CI

Configured in `.github/workflows/ci.yml`. Runs on pull requests to `main` and pushes to `main`.

Jobs:

- `Branch name policy` — enforces branch prefix convention (exits early for `dependabot/*` branches)
- `Node 18` / `Node 20` / `Node 22` — install, lint, build, typecheck

Test infrastructure will be wired up in phase 6A-4.6. Lint config improvements (extending `recommended`, etc.) tracked
as backlog.

## Required reviewers

Currently solo maintainer. When collaborators are added:

1. Add them via **Settings → Collaborators**
2. Verify branch protection requires 1 approval (already set)
3. Update this document if the count changes
