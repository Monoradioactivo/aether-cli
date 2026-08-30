# Aether CLI

The command-line interface for [Aether](https://aetherpush.com), over-the-air JavaScript bundle updates for React Native apps.

[![npm version](https://img.shields.io/npm/v/@aetherpush/cli.svg)](https://www.npmjs.com/package/@aetherpush/cli)
[![license](https://img.shields.io/npm/l/@aetherpush/cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@aetherpush/cli.svg)](https://nodejs.org)

The CLI follows semver and is on a 0.x line: a minor release may still change flags or output. Pin the exact version in CI and read the changelog before upgrading.

## Why Aether

Microsoft retired App Center CodePush in March 2025. Aether is a drop-in successor: the same release workflow, the same client contract, and a maintained SDK ([`@aetherpush/react-native-code-push`](https://www.npmjs.com/package/@aetherpush/react-native-code-push)) that replaces `react-native-code-push` without code changes. You release to named channels (Staging and Production by default), roll out to a percentage of devices, and roll back when a release goes wrong. Apps can be shared with collaborators.

Full documentation lives at [docs.aetherpush.com](https://docs.aetherpush.com).

## Install

```sh
npm install -g @aetherpush/cli
```

Requires Node.js 22 or later.

## Quick start

1. Create an account and sign in. `register` asks for your email, name, and password, then sends a verification email; click the link before signing in. `login` opens your browser, where you finish signing in — including any second factor — and authorize this machine.

   ```sh
   aether register
   aether login
   ```

2. Create an app. This also creates its Staging and Production deployments. Print the deployment keys and wire one into your app binary.

   ```sh
   aether app add my-react-native-app
   aether deployment ls my-react-native-app -k
   ```

3. Release an update. The command bundles the app and reads the target binary version from the project.

   ```sh
   aether release-react my-react-native-app ios
   ```

4. Manage the release: widen a rollout, promote it, or roll it back.

   ```sh
   aether patch my-react-native-app Staging -r 25
   aether promote my-react-native-app Staging Production
   aether rollback my-react-native-app Production
   ```

## Commands

| Command | What it does |
|---|---|
| `register` | Create a new Aether account |
| `login`, `logout` | Session management |
| `whoami` | Show the current account |
| `app add\|ls\|rm\|rename\|transfer` | Manage apps |
| `deployment add\|ls\|rm\|rename\|history\|metrics\|clear` | Manage deployment channels |
| `release`, `release-react` | Upload a new release |
| `patch` | Update metadata of an existing release (rollout %, mandatory, disabled, description) |
| `promote` | Promote a release between deployments |
| `rollback` | Roll a deployment back to a previous release |
| `collaborator add\|ls\|rm` | Manage app collaborators |
| `access-key ls\|patch\|rm` | List, rename and revoke CLI access keys (created in the dashboard under Account > CLI access keys) |
| `api-key ls\|patch\|rm` | List, rename, narrow and revoke scoped API keys for CI/CD (created in the dashboard under API Keys) |
| `session ls\|rm` | Manage active login sessions |
| `debug ios\|android` | Stream Aether logs from a running app |

Full reference and flags: `aether <command> --help`, or the [CLI reference](https://docs.aetherpush.com/cli/) in the docs.

## Hermes

`release-react` compiles the bundle to Hermes bytecode when the project has Hermes enabled, or when you pass `-h` / `--useHermes`. For that step the CLI runs the `hermesc` compiler from the project's own `node_modules`, checking these locations in order and using the first one that exists:

1. `node_modules/hermes-compiler` (React Native 0.84 and newer)
2. `node_modules/react-native/sdks/hermesc` (React Native 0.69 to 0.83)
3. the `hermesCommand` path from `android/app/build.gradle`, if set
4. `node_modules/hermes-engine` or `node_modules/hermesvm` (older projects)

If no compiler is found, the command fails and prints the paths it tried.

Known limitation: on Windows, some versions of the `hermes-compiler` package ship without a `win64-bin` binary. If a Hermes release fails on Windows with that path list, run it from macOS or Linux (for example in CI) instead.

## Signing in

`aether login` opens your browser, you approve the device there, and the CLI receives its own credential. The browser handles passwords, passkeys, authenticator codes and recovery codes, so the terminal never needs to.

On a machine with no browser — over SSH, in a container, on a locked-down host — ask for a code instead. The CLI prints a short code and a URL to open anywhere else:

```sh
aether login --device
```

The CLI falls back to this automatically when it cannot open a browser or bind a local callback port.

For CI and other machines, keep passing a key:

```sh
aether login --accessKey <your-api-key>
```

`aether logout` revokes the device on the server and then clears the local credential. If the server cannot be reached, the local credential is cleared anyway and the device can still be revoked from the dashboard under Account > CLI & Devices.

`--password` still signs in with email and password, but it is deprecated and cannot complete sign-in on accounts with multi-factor authentication.

## Configuration

The credential lives in `~/.aether/credentials.json`, readable only by you. Everything else — server URL, device id, account email — is in `~/.aether/cli.json`. Both are created on `aether login`; the credential file is deleted on `aether logout`. A `~/.aether/config.json` left by an earlier version is migrated automatically the first time you run this one.

To target a non-default server (e.g. local development):

```sh
aether login --serverUrl http://localhost:3000
```

## CI/CD

The CLI detects CI environments through the `CI` variable and runs non-interactively there; `--ci` forces it. Ready-made pipeline templates for GitLab CI, CircleCI, Jenkins, and Bitrise live in [`examples/ci/`](./examples/ci/), and GitHub Actions has a dedicated action, [`aetherpush-deploy-action`](https://github.com/Monoradioactivo/aetherpush-deploy-action). The [CI/CD guides](https://docs.aetherpush.com/ci-cd/) walk through each platform.

## Migrating from CodePush

The [migration guide](https://docs.aetherpush.com/migration/codepush/) covers both routes. In short: the Aether SDK is a drop-in replacement for `react-native-code-push` on React Native 0.76 and newer, and older apps can keep Microsoft's SDK pointed at Aether's CodePush-compatible endpoints. Existing deployment keys can be preserved with `aether deployment add -k`, so shipped binaries keep updating.

## Links

- Website: [aetherpush.com](https://aetherpush.com)
- Documentation: [docs.aetherpush.com](https://docs.aetherpush.com)
- Issues: [GitHub](https://github.com/Monoradioactivo/aether-cli/issues)

## License

[MIT](./LICENSE)
