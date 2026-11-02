# Browser service

**Asked 2026-11-01.** Slice 8 (`#8`) says browser use is helper-owned, and nothing in the tree decides *what the browser
is*. The question was: which self-hostable service gives mason a browser the agent drives and a person can take over —
and how do credentials get into it without passing through the model?

**What was wanted, in the operator's words:** something like Browserbase, but open source and self-hosted; a browser a
person can actually use for their own work, not only watch; and Bitwarden for filling a login without the secret ever
reaching the agent.

## The answer, in one paragraph

There is no self-hosted Browserbase. [**steel-dev/steel-browser**](https://github.com/steel-dev/steel-browser) is the
closest thing that exists under a licence a person can use: Apache-2.0, a real session API (`POST /v1/sessions` returns
a CDP `websocketUrl`, a `debugUrl` and a viewer URL in one response), an interactive screencast viewer, and `persist` +
`userDataDir` for logins. `kernel/kernel-images` is a better *browser box* — WebRTC live view, an HTTP computer-use
surface — but ships no session API at all: `server/openapi.yaml` has no `/sessions`, so the control plane is yours, and
its MCP server is hosted-only. Browserbase's own OSS is Stagehand (a library that wants its own model) and an archived
MCP server; there is no server to run. browserless is SSPL-or-paid. neko is a WebRTC desktop whose Chromium launches
`--bwsi` with no debugging port, so it cannot be the browser the agent drives.

## Files

| File | What is in it |
|---|---|
| [`report.md`](report.md) | The run: licence and API read from each repo, the session/handoff comparison, what Bitwarden's CLI actually requires, how each candidate attaches to an agent, what plain Playwright does not give, and the claims that could not be verified |

## What it decided

1. **The browser is a service on its own, and mason speaks CDP to it.** Not a library inside the tool machine: the
   report's §5 lists what in-process Playwright does not give — live view, session lifecycle, a profile lock, isolation,
   concurrency, and any handoff at all. The decisive one is failure isolation: a runaway page can take the tool machine
   and its RPC daemon down with it.
2. **The tool surface is mason's, not the service's.** `steel-mcp-server` and `playwright-mcp` both work, and both are a
   second agent loop's worth of behaviour bought with less control. `steel_session_live_view` is the one idea worth
   copying: the viewer's connection details are UI state and are hidden from the model.
3. **A handoff is a lease, and nobody sells one.** Every candidate hands you a viewer URL; none gives the block. neko's
   control-request flow and Cloudflare's `handoff`/`handoffComplete` are the only real arbitration protocols found, and
   neither is in a candidate. The lease (holder, epoch, block, re-observe on return, origin check) is mason's to build.
4. **A credential is filled, never read.** `bw` in a sidecar that holds `BW_PASSWORD`/`BW_SESSION` and exposes one tool,
   `fill_credential`, returning `{ok, fields}`. Bitwarden's own docs say re-prompt is not an encryption mechanism and
   that a vault should not be left unlocked unattended — so scoping is the mitigation, not the unlock: a dedicated
   account whose vault contains only what mason may use. Strictly better operationally, at the cost of a one-person org:
   Secrets Manager (`bws`), a machine-account token, and no master password at all.

## Open questions this run did not close

- **Steel against Kernel, measured.** Steel gives a session API and no WebRTC; Kernel gives WebRTC and no session API.
  For a person who wants to *use* the browser, input latency decides, and no candidate publishes a number. The only
  measurement found is third-party and alarming (`browser-handoff`, ~30 s per keystroke) and it measures a relay
  architecture, not a viewer.
- **Whether Steel's self-hosted viewer has the "Hand back" button** its MCP server tells a human to press. Unverified.
- **Whether one self-hosted Steel really serves one session at a time.** Likely, per a single `activeSession` field in
  the controller, not proven.

## Detection, and reusing the operator's own session

Asked after the first pass: a browser that gets challenged on every other site is not a browser the agent can use, and
the obvious fix is to reuse a real session rather than start a clean one.

**What actually gets a browser refused, in order of weight:**

1. **The IP.** A datacenter address is scored before a single byte of JavaScript runs. No fingerprint patch answers this;
   the egress has to be residential-grade, which is also an argument for running the browser on the operator's own
   network rather than a VPS.
2. **The TLS and HTTP/2 fingerprint.** A real Chromium has Chromium's own; a fetch library has its own and gets flagged.
   This is another reason the browser is a browser and not a scraper.
3. **The profile's standing.** Cookies, history, a resolved consent banner, a warmed cache. A brand-new profile on a
   logged-out site is the shape of a bot even when nothing is automated.
4. **CDP tells.** Real but narrower than folklore: `navigator.webdriver`, `--enable-automation` in the flag list, and
   `Runtime.enable` being called when no devtools window is open. [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
   is a patched Playwright that removes exactly these: it never calls `Runtime.enable`, injects scripts through routes
   instead, drops `--enable-automation` and adds `--disable-blink-features=AutomationControlled`. Its own README claims
   passes on CreepJS, Sannysoft, Cloudflare, Kasada, Akamai, DataDome and Fingerprint.com; those are self-reported and
   Chromium-only, and it disables `console` to do it. [Camoufox](https://github.com/daijro/camoufox) is the Firefox-shaped
   alternative for the same job.

**Reusing the operator's own browser session is harder than it looks, and one reason is new.** From Chrome 136,
`--remote-debugging-port` and `--remote-debugging-pipe` are **ignored when the profile is the default one**; the switch
must come with `--user-data-dir` pointing somewhere else, which by design uses a different encryption key
([Chrome developers blog, 2025-03-17](https://developer.chrome.com/blog/remote-debugging-port)). So "attach to my normal
Chrome" is not a supported move any more. Copying the profile directory to another machine usually fails for the same
reason from the other side: cookies are encrypted with a key held by the OS keyring, so a copy does not decrypt at its
new home.

What does work, in increasing order of moving parts:

1. **A dedicated profile inside the service, signed into once by a person through the live view.** Cookies then belong to
   the service, the profile persists, and nobody's real profile is exposed. This is the recommendation.
2. **The Playwright extension bridge** (`--extension`, driving a running Chrome through the extension's `chrome.debugger`
   permission) attaches to the operator's real session without the debugging port. It needs their machine awake and
   reachable, and it is a bigger blast radius: that browser is signed into everything they are.
3. **Copy the profile once, with the keyring key.** Possible on Linux when both ends use the same key store, brittle
   everywhere else, and it rots within weeks.

The security point that should decide it: a browser holding the operator's session is the operator, everywhere, with no
door to check at. A per-purpose profile (research, shopping) signed into a handful of sites has a boundary; the personal
profile does not. That is also why the vault broker is fill-only: reuse should be scoped by which logins exist in the
profile, not by how good the agent's judgement is that day.

Steel supports the levers this needs per session, read from its schema: `proxyUrl`, `userAgent`, `timezone`,
`dimensions`, `skipFingerprintInjection`, `persist`, `userDataDir`, `extensions`
([sessions.schema.ts](https://github.com/steel-dev/steel-browser/blob/main/api/src/modules/sessions/sessions.schema.ts)).

The next step is a container on a machine that has one, a session created through the API, a real login filled from the
vault broker, and a person typing into the same session while the agent watches. Everything above is a reading of
sources until that happens.
