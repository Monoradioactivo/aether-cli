# aether-cli Maintenance

This document captures repository settings, operational procedures, and conventions that live outside of code. Update it
whenever any of these change.

## Repository configuration

Configure via GitHub UI: **Settings → General → Pull Requests**.

- Allow merge commits: disabled
- Allow squash merging: enabled
- Allow rebase merging: disabled
- Allow auto-merge: enabled
- Automatically delete head branches: enabled

Configure via GitHub UI: **Settings → Actions → General → Workflow permissions**.

- Default workflow permissions: Read and write
- Allow GitHub Actions to create and approve pull requests: disabled. No workflow needs it: `release-please.yml` and
  `auto-merge-release.yml` open, update and merge pull requests with the release bot App token, not `GITHUB_TOKEN`.

## Rulesets

`main` is the only long-lived branch, and every change lands through a squash-merged pull request. Protection lives in
**Settings → Rules → Rulesets**, not in classic branch protection rules.

"Main Ruleset", targeting `main`:

- Pull request required, with 0 approving reviews. Stale approvals are dismissed on push, and every review thread must be
  resolved before merging.
- Required status checks, and the branch must be up to date with `main`: `Branch name policy`, `Node 22`, `Node 24`,
  `Release auto-merge gate`.
- CodeQL code scanning: an alert of any severity in the pull request's analysis blocks the merge.
- Branch deletion and force pushes: blocked.
- Bypass: the repository admin role, always.

"require-signed-commits", targeting every branch:

- Every pushed commit must carry a verified signature. An unsigned commit is refused at push time on any branch, so no
  pull request can carry one.

## Branch naming policy

Branches must start with one of:

- `feat/`: new feature
- `fix/`: bug fix
- `refactor/`: internal refactor with no behavior change
- `chore/`: tooling, dependencies, infrastructure
- `docs/`: documentation only
- `test/`: test-only additions or changes

release-please's own branches (`release-please--*`) are exempt: the `Branch name policy` job exits early for them.
Renovate branches start with `chore/renovate-` and follow the policy like any other branch.

## Repository secrets and variables

| Name                      | Kind     | Purpose                                                                                   |
|---------------------------|----------|-------------------------------------------------------------------------------------------|
| `RELEASE_BOT_APP_ID`      | secret   | App ID of the release bot, used to mint its token in the release workflows                |
| `RELEASE_BOT_PRIVATE_KEY` | secret   | Private key of the release bot App                                                        |
| `RELEASE_AUTO_MERGE_ARM`  | variable | `true` lets `auto-merge-release.yml` arm auto-merge on a release PR that passes the gate  |

No npm token is stored in the repository. Publishing uses OIDC trusted publishing (see below).

## npm trusted publisher

Configured at: **npmjs.com → @aetherpush/cli → Settings → Trusted Publisher**

- Provider: GitHub Actions
- Organization/user: `Monoradioactivo`
- Repository: `aether-cli`
- Workflow filename: `release-please.yml`
- Environment: (none)

If the workflow filename changes, this configuration must be updated. Otherwise publishes will fail with HTTP 404 from
npm.

## Bootstrap publish (one-time, manual)

Trusted publishing requires the package to exist on npm before it can be configured. The first publish was manual from
the maintainer's machine:

```sh
npm login
npm version 0.1.0-alpha.0 --no-git-tag-version
npm run build
npm publish --access public --tag alpha
```

After the package appeared on `npmjs.com/package/@aetherpush/cli`, the trusted publisher was configured (see above). All
later releases go through the workflow.

## Release process

Releases come from release-please. Nobody pushes version tags by hand.

1. Every push to `main` runs `release-please.yml`. When `feat` or `fix` commits have landed since the last release, it
   opens or updates a release PR with the version bump and changelog (also bumping the pinned CLI version in the
   `examples/ci/` templates), and keeps that PR up to date with `main`. `chore`, `docs`, `test` and `refactor` commits
   do not cut a release.
2. `auto-merge-release.yml` evaluates the release PR on pull request events, every 30 minutes, and on manual dispatch.
   It arms squash auto-merge only when every commit since the previous release is vouched for, by a `Brief-Verified:`
   trailer, by the `brief-verified` label on its pull request, or by being release-please's own commit, and the release
   is not a major bump. Otherwise the release PR waits for a maintainer. If a scheduled or dispatched run arms the
   release PR while the newest `Release auto-merge gate` check on its head is red, cancelled or missing, the run adds
   the `release-gate-recheck` label to the PR, or removes it if it is already there. The label event starts a new gate
   run on the head. The label has no other purpose. If the recheck step itself fails, the run logs a warning without
   disarming, and the next run tries again. The `Release auto-merge gate` check runs on every pull request and passes
   at once on the ones that are not release PRs.
3. Merging the release PR creates the tag and the GitHub release. The `Publish to npm` job then runs the tests, builds,
   checks that the tag matches `package.json`, and publishes with `npm publish --provenance --access public`.

### How the gate's runs are kept apart

This section describes all four npm gate repositories: `aether-cli`, `aetherpush-sdk`, `aether-expo-plugin` and
`aetherpush-deploy-action`. They carry the same workflow, and only this repository documents it.

Pull request runs are keyed by pull request number, and scheduled and dispatched runs share one `schedule` group.
Before, every run of the workflow shared a single group, so one pull request's event cancelled a gate run another
pull request was waiting on, and a run cancelled while pending leaves no check run behind.

Pull request runs may arm auto-merge here. That is the deliberate difference from `aether-server`, where only
scheduled and dispatched runs arm: these repositories have no release train to protect, and GitHub executes only a
few of the 48 daily cron slots, so waiting for a scheduled run would hold each release for hours instead of the
minutes a pull request run takes. The arm is still backed by the required `Release auto-merge gate` check and the
strict up-to-date policy, so it fires only on a head whose newest gate check passed.

Because scheduled and pull request runs now overlap, all three steps that touch an arm are written for a pull
request another run may be acting on at the same moment:

- `Arm the merge` reads the pull request's state first, leaves it alone when another run already armed or merged it,
  and re-reads instead of failing when a merge call is refused.
- `Hold the release for a human` compares the arm's `enabledAt` with this run's `run_started_at` and leaves an arm
  placed after this run started in place, because that arm carries a verdict at least as new as this one's. It
  still comments the reasons it found.
- `Disarm if this run failed` runs only when this run armed the pull request itself or its own gate refused the
  release. A run that broke before it armed anything no longer takes away an arm it did not place.

Without those three, a single transient API read, or a verdict from an older head, would strip a healthy arm and
the release would wait for the next executed scheduled slot, which is the stall this is meant to remove.

A release pull request that falls behind `main` is brought up to date by the behind bot (`behind-bot.yml`) once it
is armed; when it cannot, it comments on the pull request and notifies the ops Discord channel. An unarmed release
pull request with a green gate check is outside the bot's scope by design, and the next gate run arms it. Two cases
leave a green release pull request unarmed until a later run: the required-check confirmation refusing, which the run
summary explains, and a gate run whose compare call fails, which is reported on the pull request as a truncated
compare range and, when no newer arm is in place, disarms the release. Both wait for the next scheduled slot GitHub
actually executes.

## Dependency updates

Renovate (`renovate.json`) is the only dependency updater. Dependabot is not configured: there is no
`.github/dependabot.yml`, and Dependabot security updates are disabled.

- Schedule: before 6am on Mondays, `America/Mexico_City`, with a minimum release age of 3 days.
- Minor, patch, pin and digest updates for npm and GitHub Actions are grouped into one `weekly updates` pull request.
- Major updates wait for approval on the Dependency Dashboard issue.
- npm updates use the `chore` commit type, so they never cut a release on their own.
- OSV vulnerability alerts are enabled, and at most 3 Renovate pull requests are open at once.

## CI

Configured in `.github/workflows/ci.yml`. Runs on pull requests to `main` and pushes to `main`.

Jobs:

- `Branch name policy` (pull requests only): enforces the prefixes above.
- `Node 22` / `Node 24`: `npm ci`, lint, `npm run build` (the version-pin check plus the TypeScript compile), the
  workflow interpolation and release gate script tests, and `npm test`.

CodeQL runs separately through GitHub's default setup.

## Required reviewers

Currently a solo maintainer, and the Main Ruleset requires 0 approvals. When collaborators are added:

1. Add them via **Settings → Collaborators**
2. Decide whether the Main Ruleset should require approvals, and update this document if it does
3. Make sure each of them has a signing key registered on their GitHub account, or `require-signed-commits` will refuse
   their pushes
