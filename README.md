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

2. Create one app per platform, for example `MyApp-iOS` and `MyApp-Android`. Each app gets its own Staging and Production deployments. Print the deployment keys and wire each platform's keys into that platform's binary.

   ```sh
   aether app add MyApp-iOS
   aether deployment ls MyApp-iOS -k
   ```

3. Release an update. The command bundles the app and reads the target binary version from the project.

   ```sh
   aether release-react MyApp-iOS ios
   ```

4. Manage the release: widen a rollout, promote it, or roll it back.

   ```sh
   aether patch MyApp-iOS Staging -r 25
   aether promote MyApp-iOS Staging Production
   aether rollback MyApp-iOS Production
   ```

   Do the same with `MyApp-Android` and `android` for the Android build.

## Commands

| Command | What it does |
|---|---|
| `register` | Create a new Aether account |
| `login`, `logout` | Session management |
| `whoami` | Show the current account |
| `app add\|ls\|rm\|rename\|transfer` | Manage apps (same-workspace transfer) |
| `app-transfer create\|ls\|accept\|cancel` | Cross-workspace pending app transfers |
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

## Platform check

The server does not filter updates by platform, so an iOS bundle released to an Android app is offered to Android devices whose binary version it targets. `release-react` warns when the app name names one platform and the `<platform>` argument is the other, `MyApp-Android` with `ios` or `MyApp-iOS` with `android`: once before it bundles, and again after the release with the command that disables that release by its label (`aether patch <appName> <deploymentName> --label <label> -x`). When `--noDuplicateReleaseError` skips a duplicate, nothing is released and the second warning does not print. The release still goes out and the exit code does not change; under `--json` both warnings go to stderr.

A name counts as naming Android when it contains `android` in any case. It names iOS when it contains `ios` as its own word (`MyApp-iOS`, `myapp_ios`), `iOS` or `IOS` not right after a capital letter and not followed by a lowercase one (`MyAppiOS`, `iOSMyApp`, `MyApp-iOS17`), or `Ios` after a lowercase letter or digit (`MyAppIos`). A name that names neither platform, or both, gets no warning. `aether release` takes no platform argument and does no check.

## Hermes

`release-react` compiles the bundle to Hermes bytecode when the project has Hermes enabled, and prints which file decided. It reads:

- Android: `hermesEnabled` (or `react.hermesEnabled`) in `android/app/gradle.properties`, then `android/gradle.properties`. `false` turns compilation off, and so does an `enableHermesOnlyInVariants` setting in `build.gradle`. Without the property, the older `enableHermes: true` in `project.ext.react` still turns it on.
- iOS: `ios/Podfile.lock`. A `React-jsc` pod turns compilation off. Otherwise a `hermes-engine` pod, or the older `hermes_enabled => true` in the Podfile, turns it on. Commit `Podfile.lock` so CI sees the same pods your app was built with.

Pass `-h` / `--useHermes` to compile without checking the project, or `--useHermes false` to release plain JavaScript whatever the project says. Use `--useHermes false` when your build overrides these settings outside the project files, for example `-PhermesEnabled=false` or `USE_THIRD_PARTY_JSC=1` at `pod install`. Use it too when the target binary range still includes builds that ran JavaScriptCore: bytecode only loads on the Hermes version it was compiled for, while plain JavaScript loads everywhere.

With `-s` / `--sourcemapOutput`, a Hermes release writes the map composed from Metro's map and the compiler's. That is the map that symbolicates bytecode stack traces.

For the compile step the CLI runs the `hermesc` compiler from the project's own dependencies, checking these locations in order and using the first one that exists:

1. the `hermes-compiler` package, as `react-native` resolves it and then at the project root, only when the installed `react-native` depends on it (React Native 0.83 and newer)
2. `node_modules/react-native/sdks/hermesc` (React Native 0.69 to 0.82)
3. the `hermesCommand` path from `android/app/build.gradle`, if set
4. `node_modules/hermes-engine` or `node_modules/hermesvm` (older projects)

When Hermes was detected but no compiler is found or it cannot run on this machine, the command prints the reason and releases plain JavaScript, which every Hermes app can load. With `--useHermes` the same cases fail, printing the paths it tried or the compiler that could not start.

Known limitation: the Linux `hermesc` binaries are x86-64 only, and on Windows some versions of the `hermes-compiler` package ship without a `win64-bin` binary. On those machines a detected Hermes project releases plain JavaScript; run the release from macOS or x86-64 Linux to get bytecode.

## Signing in

`aether login` opens your browser, you approve the device there, and the CLI receives its own credential. The browser handles passwords, passkeys, authenticator codes and recovery codes, so the terminal never needs to.

On a machine with no browser — over SSH, in a container, on a locked-down host — ask for a code instead. The CLI prints a short code and a URL to open anywhere else:

```sh
aether login --device
```

The CLI falls back to this automatically when it cannot open a browser or bind a local callback port.

For CI and other machines, keep passing a key:

```sh
aether login --accessKey=<your-api-key>
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

## MCP server (beta)

`aether mcp` runs a read-only [Model Context Protocol](https://modelcontextprotocol.io) server on stdin and stdout, so an AI agent can look up your releases. It speaks protocol revision 2026-07-28 and has been checked with Claude Code 2.1.331. Clients that still open with `initialize` are refused with the version the server supports.

It offers five tools, and none of them changes anything:

| Tool | Answers |
|---|---|
| `list_apps` | Which apps and deployments the key can read |
| `get_live_release` | Which release is live on each deployment |
| `list_release_history` | Recent releases of one deployment, newest first (up to 20) |
| `get_release_health` | Install counts per release (and per app version for devices still on the store binary), plus recent automatic halts and warnings |
| `preview_rollback` | What a rollback would do. It never runs one |

Create an API key in the dashboard under API Keys and leave only the `read` scope ticked. Add the server to your client's user-level configuration, never to a project file that gets committed. With Claude Code:

```sh
claude mcp add --scope user aether -e AETHER_MCP_API_KEY=aether_sk_live_… -- npx -y @aetherpush/cli@0 mcp
```

That command leaves the key in your shell history. Other clients take the same command in their `mcpServers` configuration file, which keeps it out of the history:

```json
{
  "mcpServers": {
    "aether": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aetherpush/cli@0", "mcp"],
      "env": { "AETHER_MCP_API_KEY": "aether_sk_live_…" }
    }
  }
}
```

`@aetherpush/cli@0` asks for a 0.x release. Tool names and inputs change only in a new major version, so a future 1.0 does not reach your agent until you change that line. npm 11.12 and later fetch the newest 0.x each time the client starts the server. npm 10, the version bundled with Node.js 22, keeps whichever 0.x it downloaded first; delete `~/.npm/_npx` to pick up a newer one, or write an exact version in place of `0`. Use `npx` with the package name instead of a bare `aether`: a global install of an older CLI on the client's `PATH` answers `mcp` with its help text, which the client reads as a broken stream. The server needs Node.js 22 or later.

Keep the key's reach small:

- Issue the key from an account whose role on each app is the lowest that answers your questions. A `read` key cannot change anything, but the REST API still shows it deployment keys when its issuer's role can read them.
- The `aether login` session in `~/.aether/credentials.json` has every scope and sits on the same machine. An agent that also has shell access can read it, so give the client only the Aether tools when you can.

- `AETHER_MCP_API_KEY` must be an API key (`aether_sk_live_…`). Access keys and CLI sessions are refused, because they carry every scope.
- `AETHER_MCP_API_URL` is optional and defaults to `https://api.aetherpush.com`. It must be an https root URL; plain http is accepted only on `127.0.0.1` or `[::1]`. The CI variable `AETHER_API_URL` is not read here.
- Output is limited to what the tools need: deployment keys, blob URLs, package hashes and collaborator emails never reach the agent. Release descriptions and app and deployment names are written by your collaborators, so the server strips hidden characters, caps their length and marks them as untrusted text. Apps shared with you whose name clashes with one of your own are listed under another owner's address, so `list_apps` leaves them out and says how many it left out.
- The server makes at most 3 API calls per tool call and 20 per minute, and pauses when the tenant's remaining request budget drops to 10, so an agent cannot spend the rate limit your CI shares. After a rejected key it waits a minute before trying again.
- `list_release_history` and `preview_rollback` refuse deployments with more than 500 releases.
- stdout carries MCP messages only; diagnostics go to stderr. `aether mcp --help` lists the variables.

## Migrating from CodePush

The [migration guide](https://docs.aetherpush.com/migration/codepush/) covers both routes. In short: the Aether SDK is a drop-in replacement for `react-native-code-push` on React Native 0.76 and newer, and older apps can keep Microsoft's SDK pointed at Aether's CodePush-compatible endpoints. Existing deployment keys can be preserved with `aether deployment add -k`, so shipped binaries keep updating.

## Links

- Website: [aetherpush.com](https://aetherpush.com)
- Documentation: [docs.aetherpush.com](https://docs.aetherpush.com)
- Issues: [GitHub](https://github.com/Monoradioactivo/aether-cli/issues)

## License

[MIT](./LICENSE)
