# Secrets management and agent safety — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

The model never gets a credential. Production runtimes inject secrets at the process boundary — 1Password `op run`, Docker's proxy sentinel, an SSH agent that never exports the key — and the model sees handles [6]. Around that sit an approval gate and a reviewer that treats fetched content as hostile. Prompt-level secrecy rules are not a control; privilege separation and consent are. Mason has the right seam — pi-env separates harness from tools, pi-durable exposes `beforeTool`/`afterTool` — but local mode has no boundary: the daemon inherits the server env, `read` takes absolute paths, the control plane is unauthenticated, transcripts are world-readable. Fix: make the execution environment the credential boundary.

## Key findings

1. **Secrets are injected at the process boundary.** `op run` gives a command secret env vars for its lifetime only [5]; 1Password's MCP server cannot return secret values [7]; Docker Sandboxes' proxy keeps the real value on the host — the sandbox sees a `proxy-managed` sentinel [10]; the 1Password SSH agent signs without exporting the key [8].

2. **Computer-use products gate effects, not reading.** OpenAI's CUA confirms sensitive actions such as logins, requires supervision ("watch mode") on email, runs a monitor model that pauses on suspicious screen content, and declines banking tasks [1]. Anthropic prescribes a dedicated VM/container, no login information for the model, domain allowlists, and human confirmation for purchases and consequential decisions; injection classifiers steer the model to ask [3].

3. **Coding agents implement the gate as a permission system.** Claude Code is read-only by default, requires bash approval, keeps an allowlist plus a default blocklist for `curl`/`wget`, and encrypts credentials [4]. OpenAI's Agents SDK declares `needs_approval` on a tool, surfaces approvals as interruptions with serialized `RunState`, and fails closed when arguments cannot be inspected [2].

4. **Prompt injection is handled by architecture.** OWASP LLM01 recommends least privilege, privileged functions in code rather than given to the model, human approval for high-risk actions, and labeling external content [11]. Willison's "lethal trifecta" — private data, untrusted content, external communication — is exactly the always-on email/webhook agent [12]. CaMeL extracts control and data flow from the trusted query so untrusted data cannot alter program flow, and uses capabilities to block unauthorized flows [13].

5. **Browser credentials belong to a profile, but isolation is only as good as the tool surface.** Playwright's persistent context stores cookies and local storage in `userDataDir` and warns against automating the main Chrome profile [14]. A CDP driver can read cookies via `Network.getCookies`, so the tool must expose navigation/click/type/snapshot, not arbitrary evaluation. **[inference]**

6. **SSH keys are used, not copied.** OpenSSH warns that `-A` lets anyone who can bypass the remote socket's permissions use the local agent — not extract keys, but authenticate; a jump host is safer [15]. pi-env's SSH transport runs with `BatchMode`, strict host-key checking, and "no forwarding of any kind" [17].

7. **pi exposes the seams a gate needs.** `ToolHooks.beforeTool` runs before intent; the first `block` wins, a throw blocks, and it may replace arguments; `afterTool` runs before the result commits and may replace it [`vendor/pi/packages/durable/src/harness/types.ts:778`; `.../harness/tool.ts:136`]. Chord's `acceptWebSockets` takes an authenticator `principal(request)` that may refuse a connection [`vendor/pi/packages/chord/src/websocket.ts:12`]. Provider credentials are created 0600 in `~/.pi/agent/auth.json` [`vendor/pi/packages/coding-agent/src/core/auth-storage.ts:37`], and MCP config resolves `${VAR}` or `!command` per value [`.../docs/mcp.md:81`].

8. **Mason's gaps are concrete.** The local daemon is spawned without an `env` option [`src/server/env.ts:53`; `vendor/pi/packages/env/src/connection.ts:281`], so it inherits mason's full environment; every `bash` call defaults to `inheritEnv: true` [`vendor/pi/packages/env/src/remote-env.ts:868`]. `bash: env` puts every provider key and `op run` injection into a tool result, then SQLite, every browser, and the provider. `read` resolves absolute paths with no root [`vendor/pi/packages/durable/src/tools/path-utils.ts:12`], so `~/.pi/agent/auth.json`, `~/.ssh/*`, and `.data/agent.sqlite` are one call away. The WS and `/api/hooks/:id/fire` are unauthenticated: `principal: () => ({ kind: "owner" })` [`src/server/main.ts:147`] and a raw body-to-prompt path [`src/server/main.ts:201`; `src/server/hooks.ts:117`]. `.data/` is 0755 and `agent.sqlite` 0644 here: any local user can read the transcript. The agent can write `SOUL.md`, which is read as the preamble from the workspace [`src/server/extensions/agent-identity.ts:36`].

## How grokbot does it

- **Secrets:** passwords go into environment variables, never to the model; 1Password fills a login only on the site that asks, and "the password never reaches the model". Boundary injection, not a prompt rule.
- **Effects:** purchases and payments wait for Allow/Deny; actions on your own laptop need approval.
- **Review:** a separate model checks risky actions before they run; a block becomes an approval request; no answer in 15s means blocked. A layer, not the boundary.
- **Provenance:** email/webhook text is labeled untrusted; memories are information, not instructions.
- **Consent:** it will not message people or send email unless asked; new routines need the user's OK.

The lecture [16] assumes the model is not robust to injection and puts controls around it. **[inference]**

## Mason applicability

**Threat model.** Assets: provider keys and `auth.json`, SSH keys, browser cookies, the user's files and laptop, money, the user's identity as sender, and the transcript. Adversaries: anyone who can write text the agent reads (email, webhook, web page, repo file, widget), any local process that reaches the server port, a compromised provider, and mistakes. The combination is here: mason reads external payloads, has private data, and executes shell commands with the user's full authority.

| Boundary | Today | Consequence |
|---|---|---|
| Model ↔ tools | `bash`, `write`, `edit` with the user's uid; no approval | one injected sentence can act anywhere the user can |
| Secrets ↔ tools | daemon inherits server env; absolute reads; auth.json readable | one `env` or `cat` leaks credentials into the model, DB, and UI |
| External text ↔ conversation | hook payload raw; `[EVENT HOOK]` is a scope claim, not a trust label | indirect injection with apparent authority |
| Web client ↔ server | every WS is `owner`; hook endpoint unauthenticated | a local process or site can drive the agent |
| Model ↔ storage | all tool I/O persisted and replicated; DB 0644 | a leak becomes durable and world-readable |
| Agent ↔ self | `SOUL.md` read from the writable workspace | the model persists instructions across sessions |

**Target architecture** (pi's own docs reach the same conclusion [18]):

1. **Execution env as the boundary.** Run tools in a container/VM (pi-env SSH is supported) with only the workspace mounted, no host `~`, and an egress allowlist. Keep provider keys on the mason host; the tool host gets none. Local mode stays for development, with a scrubbed env and a warning.
2. **Secret store → broker → tool.** 1Password as the store (service account scoped to one vault [9]), `op run` launching a broker on a 0600 Unix socket. Tools take handles (`credential://github/repo`, `credential_status`) and the broker performs the authenticated action; the model never receives a value. A `mason-auth` wrapper authenticates `git`/`gh` without exporting the token. Browser cookies stay in a dedicated profile; login is a user action, and the browser tool cannot read cookies. SSH uses the 1Password agent socket.
3. **Risk gate + provenance.** A `beforeTool` hook tiers every call: observe (auto), local mutation (auto + diff), code execution (reviewer for network/install/`sudo`/`rm -rf`/outside-workspace), identity/outbound (approval), money (approval, no standing consent), credentials (approval, value never returned), self-modification (approval), host-escape paths (block + alert). The reviewer sees the rendered call and the user's last request, not the rationale. Failed or unknown review blocks; 15s without an answer blocks. `afterTool` redacts known secrets before commit, as a safety net. Hook payloads get an envelope (`source`, `trust: untrusted`) and a prompt section saying content inside is data.

**Already there vs missing.** Mason has the split (`src/server/env.ts`), durable tasks/hooks, and Chord's principal seam. It lacks env scrubbing, path confinement, control-plane auth, hook signatures, a gate, redaction, a secret broker, and a real sandbox default. It needs a secure-input path (`request_secret` → password field → broker).

## Recommended actions

1. **[now]** Spawn the local daemon with a minimal environment (`env -i PATH HOME LANG TMPDIR`); pass only benign values through `shellEnv`. Test: `bash -c env` has no `*_KEY` or `PI_ENV_SSH_*`.
2. **[now]** Authenticate the control plane: random token in `.data/` (0600), checked by `principal(request)` for WS and HTTP; reject foreign `Origin`; refuse non-loopback `HOST` without it. Test: unauthenticated WS and hook POST are refused.
3. **[now]** Sign webhooks (per-hook HMAC, reject stale) and wrap the payload in `<untrusted source="hook:<id>">`; add a system section: only direct user messages and the system prompt are instructions. Hook metadata authorizes the check-in, not actions described in the payload.
4. **[now]** Fix storage permissions: `.data` 0700, SQLite files 0600 at creation; test another uid cannot read the transcript.
5. **[now]** Denylist secret paths in `read` and the gate (`~/.ssh`, `~/.pi/agent`, `~/.aws`, `~/.config/op`, `.data/`, `/proc/*/environ`). The sandbox is the real fix.
6. **[next]** Implement the `beforeTool` gate: tiers, reviewer call, 15s deadline, fail-closed, approval card. Shadow mode first, then enforce. Self-modification (SOUL.md, routines, extensions) is top tier.
7. **[next]** Add `afterTool` redaction for registered secret values and high-entropy patterns before commit; test a synthetic key never appears in the transcript or Chord view.
8. **[next]** Build the credential broker and `credential_status`/`request_secret` tools; wire `op run` to the broker only, not to the mason server.
9. **[next]** Make the sandboxed target the default for real use: container or SSH VM, workspace-only mount, no host `~`, egress allowlist; keep local mode named `dev`.
10. **[later]** Browser tool with a dedicated profile, origin-bound login, no cookie or CDP-eval reads; SSH through the 1Password agent socket.
11. **[later]** CaMeL-style capability tokens for outbound tools (recipient/subject-bound approval), if the agent gets standing autonomy.
12. **[don't]** Do not start mason with `op run` (it puts every secret in the daemon's env). Do not add MCP servers or tools that return secret values. Do not rely on prompts, redaction, or the reviewer as the boundary. Do not forward an SSH agent to an untrusted host or copy private keys into the execution env.

## Open questions

- Does `inheritEnv: false` plus a small `shellEnv` keep a usable PATH/login shell?
- Can 1Password service accounts unlock unattended on this headless host, or does the broker need a desktop session?
- Can `beforeTool` await a Chord approval for 15s without blocking the scheduler or losing the request on restart?
- Where should `SOUL.md` live so the agent can read it but not rewrite it without approval?
- No primary source for grokbot internals beyond the lecture notes.

## Sources

1. https://openai.com/index/computer-using-agent/
2. https://openai.github.io/openai-agents-python/human_in_the_loop/
3. http://web.archive.org/web/20250603040249/https://docs.anthropic.com/en/docs/agents-and-tools/computer-use
4. http://web.archive.org/web/20250913203510/https://docs.anthropic.com/en/docs/claude-code/security
5. https://developer.1password.com/docs/cli/secrets-environment-variables/
6. https://www.1password.dev/get-started/secure-ai-access.md
7. https://www.1password.dev/environments/mcp-server.md
8. https://developer.1password.com/docs/ssh/agent/
9. https://developer.1password.com/docs/service-accounts/
10. https://docs.docker.com/ai/sandboxes/configuration/credentials/
11. https://genai.owasp.org/llmrisk/llm01-prompt-injection/
12. https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
13. https://arxiv.org/abs/2503.18813
14. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
15. https://man.openbsd.org/ssh#A
16. `.scratch/grokbot-insights/SOURCE-grokbot-lecture.md`
17. `vendor/pi/packages/env/README.md`, `vendor/pi/packages/env/docs/protocol.md`
18. `vendor/pi/packages/coding-agent/docs/security.md`, `.../docs/containerization.md`, `.../docs/mcp.md`
19. `vendor/pi/packages/durable/src/harness/types.ts:778`, `.../harness/tool.ts:136`, `vendor/pi/packages/env/src/remote-env.ts:868`, `vendor/pi/packages/env/src/connection.ts:281`, `vendor/pi/packages/durable/src/tools/path-utils.ts:12`
20. `src/server/env.ts:53`, `src/server/main.ts:147`, `src/server/main.ts:201`, `src/server/hooks.ts:117`, `src/server/extensions/agent-identity.ts:36`, `src/web/main.tsx:97`
