# Aether CLI

> **Push React Native updates without the App Store.**

The command-line interface for [Aether](https://aetherpush.com) — over-the-air JavaScript bundle updates for React Native apps.

[![npm version](https://img.shields.io/npm/v/@aetherpush/cli.svg)](https://www.npmjs.com/package/@aetherpush/cli)
[![license](https://img.shields.io/npm/l/@aetherpush/cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@aetherpush/cli.svg)](https://nodejs.org)

> ⚠️ **Pre-release.** Aether is in active development. APIs and behavior may change before the first stable release.

---

## Why Aether

Microsoft retired App Center CodePush in March 2025, leaving thousands of React Native apps without an OTA update solution. Aether is a drop-in successor: same workflow, same client SDK contract, run by a small team focused on shipping.

- **App Store-free deployments** — push bug fixes and updates directly to installed apps
- **Compatible with `react-native-code-push`** today; first-party Aether SDK ships next
- **Channel-based releases** — Staging, Production, Beta, whatever you need
- **Rollouts and rollbacks** — percentage-based rollouts, instant rollback to any previous label
- **Multi-collaborator** — own your apps, share access with your team

## Install

```sh
npm install -g @aetherpush/cli
```

Requires Node.js 22 or later.

## Quick start

```sh
# Create an account (interactive: prompts for email, name, password)
aether register

# Verify your email by clicking the link sent to you, then log in
aether login

# Create your first app (auto-provisions Staging and Production deployments)
aether app add my-react-native-app

# Inspect the deployment keys to wire into your app binary
aether deployment ls my-react-native-app -k

# Release an update (auto-detects entry file and target binary version)
aether release-react my-react-native-app ios

# Roll out to 25% of users
aether patch my-react-native-app Staging -r 25

# Promote a release from Staging to Production
aether promote my-react-native-app Staging Production

# Roll back if something goes wrong
aether rollback my-react-native-app Production
```

## Commands

| Command | What it does |
|---|---|
| `register` | Create a new Aether account |
| `login`, `logout` | Session management |
| `whoami` | Show the current account |
| `app add\|ls\|rm\|rename\|transfer` | Manage apps |
| `deployment add\|ls\|rm\|rename\|history\|clear` | Manage deployment channels |
| `release`, `release-react` | Upload a new release |
| `patch` | Update metadata of an existing release (rollout %, mandatory, disabled, description) |
| `promote` | Promote a release between deployments |
| `rollback` | Roll a deployment back to a previous release |
| `collaborator add\|ls\|rm` | Manage app collaborators |
| `access-key add\|ls\|patch\|rm` | Manage session-style CLI keys |
| `session ls\|rm` | Manage active login sessions |
| `debug ios\|android` | Stream Aether logs from a running app |

Full reference and flags: `aether <command> --help`.

## Configuration

Session and server config are stored in `~/.aether/config.json`. Created on `aether login`, deleted on `aether logout`.

To target a non-default server (e.g. local development):

```sh
aether login --serverUrl http://localhost:3000
```

To run non-interactively (CI/CD):

```sh
aether login --accessKey <your-access-key> --serverUrl https://api.aetherpush.com
```

## CI/CD

Dedicated GitHub Action, GitLab CI / CircleCI / Jenkins templates, and a CLI `--ci` auto-detect flag are coming in the next release. For now, use `aether login --accessKey` with a long-lived access key.

## Migrating from CodePush

If you're coming from `appcenter-cli` and `react-native-code-push`, a migration tool and step-by-step guide are on the way. Until then, your existing `react-native-code-push` SDK works against Aether servers unchanged — just swap your deployment key for one issued by `aether deployment ls -k`.

## Links

- Website: [aetherpush.com](https://aetherpush.com)
- Issues: [GitHub](https://github.com/Monoradioactivo/aether-cli/issues)

## License

[MIT](./LICENSE)
