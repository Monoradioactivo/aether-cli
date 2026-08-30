# Changelog

## [0.6.1](https://github.com/Monoradioactivo/aether-cli/compare/v0.6.0...v0.6.1) (2026-08-30)


### Bug Fixes

* **cli:** drop the retired package diffing types ([#108](https://github.com/Monoradioactivo/aether-cli/issues/108)) ([719e3a2](https://github.com/Monoradioactivo/aether-cli/commit/719e3a27d617bbf6349bb86bbbd733ba304d4476))

## [0.6.0](https://github.com/Monoradioactivo/aether-cli/compare/v0.5.2...v0.6.0) (2026-08-27)


### Features

* **ci:** add bitrise CI support ([#102](https://github.com/Monoradioactivo/aether-cli/issues/102)) ([396ee67](https://github.com/Monoradioactivo/aether-cli/commit/396ee67e5f4dbe7a1bc36c9b05f2e0239df3f45c))

## [0.5.2](https://github.com/Monoradioactivo/aether-cli/compare/v0.5.1...v0.5.2) (2026-08-21)


### Bug Fixes

* **cli:** explain dashboard-only key commands in one line ([#100](https://github.com/Monoradioactivo/aether-cli/issues/100)) ([3bf3132](https://github.com/Monoradioactivo/aether-cli/commit/3bf313245b1b1417b274a5b32fa853a1590e29b5))

## [0.5.1](https://github.com/Monoradioactivo/aether-cli/compare/v0.5.0...v0.5.1) (2026-08-20)


### Bug Fixes

* **cli:** make the published bin executable ([9cc07c1](https://github.com/Monoradioactivo/aether-cli/commit/9cc07c164e1f4c6840b371382570e2889e7dc5ca))

## [0.5.0](https://github.com/Monoradioactivo/aether-cli/compare/v0.4.2...v0.5.0) (2026-08-17)


### Features

* **auth:** sign in through the browser ([#95](https://github.com/Monoradioactivo/aether-cli/issues/95)) ([d406762](https://github.com/Monoradioactivo/aether-cli/commit/d406762110c2c289a3d0fd8d4427064445ad2961))


### Bug Fixes

* **auth:** fall back to the production server when none was overridden ([#97](https://github.com/Monoradioactivo/aether-cli/issues/97)) ([acc851d](https://github.com/Monoradioactivo/aether-cli/commit/acc851d4c29dc5dcbc8e14979850bb5b085548d3))

## [0.4.2](https://github.com/Monoradioactivo/aether-cli/compare/v0.4.1...v0.4.2) (2026-08-16)


### Bug Fixes

* **auth:** explain the access-key login path for MFA accounts ([#93](https://github.com/Monoradioactivo/aether-cli/issues/93)) ([f7c2d5f](https://github.com/Monoradioactivo/aether-cli/commit/f7c2d5f3ac0ef5bb5392b7dcc0636c79facc0bcd))

## [0.4.1](https://github.com/Monoradioactivo/aether-cli/compare/v0.4.0...v0.4.1) (2026-07-26)


### Miscellaneous Chores

* release 0.4.1 ([2fa1abc](https://github.com/Monoradioactivo/aether-cli/commit/2fa1abc16a77828d7b26ddb145219ec579973afb))

## [0.4.0](https://github.com/Monoradioactivo/aether-cli/compare/v0.3.4...v0.4.0) (2026-07-20)


### Features

* **cli:** sign releases from the release command ([#78](https://github.com/Monoradioactivo/aether-cli/issues/78)) ([fd98087](https://github.com/Monoradioactivo/aether-cli/commit/fd98087098b435485f4be8f812524b8b6eb12a16))

## [0.3.4](https://github.com/Monoradioactivo/aether-cli/compare/v0.3.3...v0.3.4) (2026-07-20)


### Bug Fixes

* **cli:** default to the production server URL ([#75](https://github.com/Monoradioactivo/aether-cli/issues/75)) ([2ea3737](https://github.com/Monoradioactivo/aether-cli/commit/2ea37372cf93cd62bbfdaa10a3afdd4be32d1a8d))

## [0.3.3](https://github.com/Monoradioactivo/aether-cli/compare/v0.3.2...v0.3.3) (2026-07-19)


### Bug Fixes

* **cli:** resolve hermesc from the hermes-compiler package on RN 0.84+ ([#72](https://github.com/Monoradioactivo/aether-cli/issues/72)) ([691cf1c](https://github.com/Monoradioactivo/aether-cli/commit/691cf1ca81cc47ed2136a7b5f6830dc73d818d04))

## [0.3.2](https://github.com/Monoradioactivo/aether-cli/compare/v0.3.1...v0.3.2) (2026-06-17)


### Bug Fixes

* **cli:** make login idempotent in non-interactive mode ([6e0dae1](https://github.com/Monoradioactivo/aether-cli/commit/6e0dae13fd2b180c07e0640dcc5af77748485152))

## [0.3.1](https://github.com/Monoradioactivo/aether-cli/compare/v0.3.0...v0.3.1) (2026-06-15)


### Bug Fixes

* **cli:** route release-react progress output to stderr in --json mode ([72b825f](https://github.com/Monoradioactivo/aether-cli/commit/72b825fa746d224f4a66d1a9dba9c662764d314a))

## [0.3.0](https://github.com/Monoradioactivo/aether-cli/compare/v0.2.0...v0.3.0) (2026-05-29)


### Features

* **cli:** add --json output mode to release and release-react ([#43](https://github.com/Monoradioactivo/aether-cli/issues/43)) ([d327cec](https://github.com/Monoradioactivo/aether-cli/commit/d327cecdef5b2412d4c343937791ae7c24946d65))
* **cli:** add global --non-interactive flag for headless runs ([#40](https://github.com/Monoradioactivo/aether-cli/issues/40)) ([eed2d7b](https://github.com/Monoradioactivo/aether-cli/commit/eed2d7b566b624a90d0c49b41d345aac1c0a9e9b))
* **cli:** auto-enrich release descriptions with CI metadata ([#42](https://github.com/Monoradioactivo/aether-cli/issues/42)) ([41d4d19](https://github.com/Monoradioactivo/aether-cli/commit/41d4d191c44ce78edbaafb271d4deeb86149b2cb))
* **cli:** exit non-zero on invalid arguments ([#38](https://github.com/Monoradioactivo/aether-cli/issues/38)) ([8e21f66](https://github.com/Monoradioactivo/aether-cli/commit/8e21f66d71ff3379c8ef6d3b109b5f5033d05e4c))
* **cli:** require --force for destructive commands in non-interactive mode ([#41](https://github.com/Monoradioactivo/aether-cli/issues/41)) ([3da4bb0](https://github.com/Monoradioactivo/aether-cli/commit/3da4bb0e8672f47db7e7b05aa34752ba9e28e5ce))

## [0.2.0](https://github.com/Monoradioactivo/aether-cli/compare/v0.1.1...v0.2.0) (2026-05-27)


### Features

* **cli:** add api-key add/patch/list/remove commands ([#33](https://github.com/Monoradioactivo/aether-cli/issues/33)) ([853147f](https://github.com/Monoradioactivo/aether-cli/commit/853147f94175359c511091ba2c9fc9fd5dd57978))
