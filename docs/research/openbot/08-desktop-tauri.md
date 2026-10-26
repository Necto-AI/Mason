# Desktop (Tauri)

## What it is

`desktop/` is a Tauri 2 shell whose product is "run OpenBot on your own machine" (`desktop/src-tauri/tauri.conf.json:51-52`). It is two applications under one window: a setup wizard (Rust commands plus a small React app in `desktop/src/`) that installs a container engine, fetches a release, raises the stack and proves it answers; then the same webview navigates into the local web app (`desktop/src-tauri/src/main.rs:2472-2482`). The Rust side is the substantive part — 42.6k lines — and it is where every capability the browser cannot have lives.

## How it works

**Packaging: a small installer and a fetched tree.** The bundle is the Tauri binary plus icons (`tauri.conf.json:41-48`). Everything needed to run is fetched on first run from the release's own source tarball at a tag — never `main` — plus a `container-images.json` manifest published beside it (`desktop/src-tauri/src/deployment.rs:1-12`, `:40-48`). The tarball is unpacked selectively — `docker-compose.yml`, `server`, `app`, `worker` plus nine supporting entries — with archive paths refused unless every component is an ordinary name (`deployment.rs:245-280`, `:287-315`). A stamp file written *last* is what says the fetch finished (`deployment.rs:168-200`). Images come only from the manifest (`deployment.rs:83-130`); the references are written as `@sha256:` digests and a test asserts that shape (`deployment.rs:392-404`), but nothing at runtime refuses a manifest that carries a tag.

**What runs.** Compose owns `postgres`, `supervisor`, `agent-computer` and two optional bundled Bots (`stack.rs:24-30`, `:39-90`). Three processes are deliberately *not* containers — `server`, `app` and `worker` — because the shipped image omits the supervisor and the dashboard (`stack.rs:1-10`, `:103-126`). So the shell also has to be their restart policy. It downloads a pinned Bun and Podman + Compose, verifies each against a hard-coded SHA-256 and refuses a mismatch (`install.rs:14-16`, `:42-47`, `:150-180`), then runs `bun install --frozen-lockfile --ignore-scripts` (`stack.rs:850-862`).

**Rust command surface.** 36 commands are registered (`main.rs:3756-3793`): engine detection and preparation, installation, lifecycle (`start_stack`, `stop_stack`, `already_running`, `last_failure`, `show_openbot`, `show_setup`, `reset_leftover_database`), settings (`harnesses`, `providers`, `already_configured`, roots), the sign-in families, each with `begin`/`finish`/`cancel`, `ask_the_bot`, and one telemetry sink. `start_stack` takes a root, two URLs, a key, a model and a harness and no policy (`main.rs:1245-1266`); `stop_stack` is documented as accepting no setting from the webview (`main.rs:1645-1647`).

**Capabilities.** The setup window is granted `core:event:default` and `opener:allow-open-url` for http/https only (`capabilities/default.json:6-12`). Nothing under `shell:`, `dialog:` or `fs:` is granted, so the webview cannot spawn, open a file dialog or touch disk; those plugins are called from Rust only (`main.rs:3749-3755`). CSP is `null` (`tauri.conf.json:23`); once the window is the local web app that origin's policy applies, but the wizard's own document has none.

**Sign-in that needs the native process.** Provider OAuth runs in Rust, not React: Google uses a loopback listener on `127.0.0.1:0` with PKCE S256 (`provider_oauth.rs:155-192`), xAI uses device authorization (`provider_oauth.rs:195-232`). Claude and ChatGPT *plan* sign-in runs Anthropic's own CLI, bundled inside the harness image, through a PTY (`plan.rs:1-18`), with a loopback relay for ChatGPT's callback (`plan.rs:513-527`). Intelligence sign-in is a loopback callback with a random state token (`intelligence.rs:94-110`). Credentials never reach React; they are written into the deployment and stored by `vault.rs` — an owner-only file on macOS/Linux, DPAPI on Windows, never on a command line (`vault.rs:1-12`, `PROVIDER_OAUTH.md:64-70`).

**Microphone.** Only an entitlement and an `NSMicrophoneUsageDescription` (`src-tauri/Entitlements.plist`, `src-tauri/Info.plist`). The recording code is the web app's (`app/src/lib/voice/*`); the desktop contributes the packaged-app permission and nothing else, and `MACOS_MICROPHONE.md` is a manual verification script, not a feature.

**The local bridge (host access).** The one thing the web genuinely cannot do. The server decides a Bot may use host tools; the desktop owns every path decision and every execution boundary (`host_access.rs:1-5`). It is an **outbound poll**: every second the desktop GETs `http://127.0.0.1:<server-port>/api/host-access/desktop/next` with `Authorization: Bearer <token>` and POSTs results back (`host_access.rs:575-590`, `:670-680`). The token is 32 random bytes, base64url, minted fresh per Start, inserted only into the `server` child's environment, explicitly removed from `app` and `worker` (`main.rs:1579-1584`, `stack.rs:1123-1129`); it is never written to `.env`, never Compose, never the vault. The server compares it in constant time and answers 503 when unconfigured (`server/src/host-access/routes.ts:11-24`, `:58-70`).

Operation kinds are `ChooseFolder | ListFiles | ReadFile | WriteFile | RunCommand | Cancel | Stop` (`host_access.rs:364-380`). Nothing runs without a grant created by a **native folder picker plus a native confirm** (`desktop_host_access.rs:111-161`), and the desktop refuses to approve what it cannot show in full — over 2000 characters, 24 lines or containing NUL is refused, not truncated (`desktop_host_access.rs:31-37`). Paths are canonicalised, `..`/absolute/prefix components rejected, and the result must stay under the granted root (`host_access.rs:1559-1600`); a forbidden list covers `$HOME` itself, `.ssh`, `.gnupg`, `.aws`, keys and cloud directories, browser profiles, `/System` and `/etc` (`host_access.rs:1462-1512`). Each operation is a container: `--network none`, `--read-only` root, `--cap-drop ALL`, `no-new-privileges`, 128 pids, 512 MB, 1 CPU, the approved folder bound read-only unless the operation writes, and `timeout` inside (`host_access.rs:1330-1401`). Writes snapshot the previous file into `.openbot-backups/` first (`host_access.rs:858-903`). Operations expire after 120 s, cap at 4 concurrent, one per Bot, replay is refused, and an unrecognised policy word degrades to "ask" (`host_access.rs:25-33`, `:727-762`, `:250-272`). A missing runtime, image, approval, grant or cleanup is an error, never an unsandboxed fallback (`host_access.rs:3-5`).

**Tray.** Closing hides the window, because a destroyed window leaves a tray pointing at nothing while the stack runs (`main.rs:3804-3813`); a second launch restores the first (`main.rs:3749-3751`).

**Auto-update.** None. No `tauri-plugin-updater`, no `plugins.updater` block, no `latest.json`; `Cargo.toml:33-36` lists only shell, single-instance, opener and dialog. The only "update" is `needs_fetch` comparing the app's version against the deployment stamp (`deployment.rs:168-200`): the *deployment* moves forward, the binary does not.

**Signing.** Windows is real: `tauri.windows-signing.conf.json:1-15` overrides `bundle.windows.signCommand` to `pwsh scripts/sign-windows.ps1 %1`; the script refuses unless `WINDOWS_SIGNING=keyvault`, fetches a vault-scoped token per invocation, signs via `AzureSignTool` against an HSM-resident certificate, and never puts the token in a file or `GITHUB_ENV` (`desktop/scripts/sign-windows.ps1:1-32`). The workflow is gated `none|keyvault`, runs under a protected `windows-signing` environment with `id-token: write`, OIDC-federates to the NuGet lane's app registration (`.github/workflows/desktop-signing.yml:3-10`, `:47-56`; `desktop/signing/azure-federation.json:1-7`), then extracts the exe from the NSIS installer and verifies publisher, chain, timestamp and version on both files (`desktop/scripts/verify-windows-signatures.ps1:30-60`). macOS is *not*: CI builds with `APPLE_SIGNING_IDENTITY='-'`, ad hoc and explicitly notarisation-free, deferring Developer ID to a later step (`.github/workflows/desktop.yml:54-56`, `:110`).

## Decisions and their reasons

- **The fetched source tree is not digest-pinned.** Installers are (`install.rs:150-180`); the tarball itself is fetched over TLS and then executed via Bun with no checksum (`deployment.rs:221-232`), and the image manifest is trusted as published. The "nothing fetched here is run unverified" rule is written in `install.rs:14-16`, not in `deployment.rs`; read as one rule for the whole setup, it is not one.
- **The wizard ends with proof, not "saved"** (`ask.rs:1-12`, `Ask.tsx:1-13`): a run that produces no text is a failure, not a stalled stream (`ask.rs:13-24`).
- **Three host processes plus Compose instead of one entrypoint**, because the shipped image deliberately omits them (`stack.rs:1-10`).
- **Outbound poll rather than a listening port on the host.** Buys nothing new to scan or firewall; costs a lease machine on the server.
- **Sandbox every host operation in a fresh container** rather than as the user: costs a 30 s timeout and an image dependency, buys a boundary that is `--network none` rather than a dialog.
- **Docs versus code.** Five bundle targets are declared (`dmg`, `nsis`, `appimage`, `deb`, `rpm`) but only Windows signing exists, and `Tauri-signing-SKILL.md:30-40` spends half its length on updater keys openbot does not ship.

## Mason-relevant

- **Worth copying:**
  - The proof screen at the end of setup, and the rule that a silent run is a failure with openbot's own sentence and the container log behind a developer register (`ask.rs:13-24`). A deployment check that ends at "server started" is the same mistake.
  - The bridge shape: **outbound poll + per-run bearer + server-driven state machine**. A device that reaches outward cannot be reached by anything else on the LAN.
  - Native approval for anything outside the workspace, with refusal rather than truncation when the content cannot be reviewed in a dialog (`desktop_host_access.rs:31-37`). This is the honest version of a permission prompt.
  - `--ignore-scripts` on `bun install`, reason written down (`stack.rs:851-857`), and installers that refuse a wrong digest.
- **Worth avoiding:**
  - Executing a source tarball with no checksum. If mason ever fetches its own tree, pin it or sign the manifest.
  - CSP `null` on a window that later becomes an app origin.
  - A 10.4k-line `main.rs` holding the IPC surface and its tests; 36 commands in one handler list is a review surface nobody reads twice.
  - Registering a plugin you never call (`tauri-plugin-shell`, `main.rs:3752`).
  - Signing Windows while macOS distribution stays ad hoc: one release, two trust stories.
- **Already right in mason:**
  - The execution boundary is already a separate process reached over a transport (`pi-env` `Connection`, `docs/EXECUTION-TARGETS.md`), and every tool goes through `RemoteExecutionEnv`. That is the seam openbot had to invent as the host-access broker. A native shell for mason should launch and pair, not become a second execution surface.
  - The token/cookie/HMAC door and the Origin gate (§4.1b) mean a mason desktop can be a client of an existing door, where openbot needed 36 Rust commands because its desktop *is* the trust boundary.
  - `agent/` vs `service/` (ADR-0002) keeps credentials out of the agent's reach; openbot gets there by keeping provider tokens out of React (`PROVIDER_OAUTH.md:64-70`).
- **One contradiction:** mason's door (§4.1b) assumes a long-lived device token in the OS keystore; openbot keeps no client credential and mints one per run. Keep both — the device token answers *may this device speak*, the run token *may this run touch this machine*.

**What a mason native shell would need:** a launcher for the server and the `pi-env` daemon that a tray can wake; a per-launch token handed only to the server process; a native folder-approval path if the workspace must sit outside a fixed directory; and packaging for Node plus the daemon. It does **not** need host-access brokering, OAuth in Rust, or a container engine.

## Open questions

- Does the release ever ship a Developer ID-signed, notarised `.dmg`? Nothing in-tree does (`.github/workflows/desktop.yml:54-56`); the release assets would settle it.
- What a Bot sees when no desktop is polling (`server/src/host-access/routes.ts:71-77` answers an empty lease), and what a Stop mid-approval does to a pending native dialog: the broker is retired before the API server (`main.rs:29-30`), so it presumably fails closed, but no test covers it.
