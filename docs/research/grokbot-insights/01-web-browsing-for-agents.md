# Web browsing for agents — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: pi research subagent (parallel run).

## Summary

Production practice in 2025–2026 converged on **structure first, pixels as fallback, a human at the walls**. Playwright MCP, Chrome DevTools MCP and Anthropic's browser tool all drive pages through accessibility/DOM nodes with stable refs; Operator's screenshot-only CUA reports 38.1% on OSWorld. Structure is not automatically cheap: a real a11y-snapshot tool cost 3.5–14k tokens per page in my measurements, against ~1.5k for a screenshot, so the win is *targeted* extraction and a per-call budget, not a snapshot per step. Sessions persist via a profile, but Chrome's App-Bound Encryption binds cookies to a machine, so VM snapshots do not port logins across hosts. For mason the cheapest correct path already exists on this machine: `agent-browser` (Rust CDP CLI with `@eN` refs, profiles, auth vault, confirm/deny) behind the existing `bash`/`pi-env` boundary — not a 72-tool MCP server in the prompt.

## Key findings

1. **A11y tree with refs is the default fast path.** Playwright MCP drives pages "through structured accessibility snapshots, bypassing the need for screenshots …" [1]. Chrome DevTools MCP's `take_snapshot` is a text snapshot "based on the a11y tree"; "Prefer taking a snapshot over taking a screenshot" [2]. Anthropic's Playwright tool targets elements by `ref`, which "works across different screen sizes and layouts, unlike pixel coordinates that break when windows resize" [3]. Underneath: CDP `Accessibility.getFullAXTree` / `queryAXTree` [4].

2. **Vision alone is measurably weaker.** Operator's CUA "interprets screenshots and interacts with graphical user interfaces" [5] and scores **38.1% on OSWorld**, which OpenAI calls "not yet highly reliable" [5]. SeeAct: GPT-4V's own grounding reached 46.4% element accuracy vs 66.4% with human (oracle) grounding; 51.1% whole-task success only with oracle grounding; "set-of-mark prompting turns out to be not effective for web agents", and the best automatic strategy "leverages both the HTML structure and visuals" [6]. WebVoyager's screenshot agent reached 59.1% on 15 live sites (2024) [7]. WebArena's a11y-tree GPT-4 agent: 14.41% vs 78.24% human [8] — representation is not the only bottleneck.

3. **Token cost, measured.** Anthropic: "each screenshot is roughly 1,500 input tokens"; 30 turns ≈ 45k tokens re-sent per call, hence caching plus image pruning (`image_prune_min=3`, `image_prune_interval=40`, summarization at 150k) [9]. On this machine (2026-10-18, tokens ≈ chars/4): a raw CDP AX reconstruction is 1.1–6.1k tokens for Wikipedia, GitHub, HN and MDN; the `agent-browser` snapshot the model actually sees is larger — HN **6.7k** full / **3.5k** with `-i`; GitHub repo **14.2k** full / **5.3k** with `-i`; `-d 4` changed nothing on HN. `agent-browser read` was 1.1k on HN but 14.7k on the GitHub page, so text extraction needs truncation too. No mechanism is cheap by default; every observation needs a per-call budget.

4. **Tool-surface cost is the second bill.** Playwright MCP documents **72** tool entries; Chrome DevTools MCP **59** [1][2]. Playwright's own docs now recommend "CLI + SKILLs" for coding agents: "CLI invocations are more token-efficient: they avoid loading large tool schemas and verbose accessibility trees into the model context", reserving MCP for loops that need "persistent state, rich introspection, and iterative reasoning" [1]. pi's MCP integration defaults to `"exposure": "codemode"`, keeping MCP tools out of the model's declarations [10]; the same "expose an API, let the model write code" pattern is now a published MCP critique [19].

5. **What actually breaks, and the published fixes.**
   - *CAPTCHA / bot walls*: Anthropic's Playwright demo "hits CAPTCHAs when searching Google.com" [3]. Cloudflare's JavaScript Detections engine "identifies headless browsers"; bot scores run 1–99, and the product set now includes AI Labyrinth and Block AI Bots [11]. The market answer is stealth Chromium with randomised fingerprints and residential proxies, plus CAPTCHA solving by default [12] — an arms race, not a fix.
   - *Login / 2FA*: "The most reliable options are a saved profile or a human checkpoint" — reuse the profile while cookies last, else stop and let the user type the code through a live view [13].
   - *Canvas*: "The `<canvas>` element on its own is just a bitmap and does not provide information about any drawn objects. Canvas content is not exposed to accessibility tools as semantic HTML is" [14]. It needs pixels or app hooks.
   - *Infinite scroll*: no canonical primitive; scroll until `scrollHeight`/item count is stable for N rounds, then extract [inference].
   - *Prompt injection from page text*: Operator measured 23% susceptibility with mitigations (62% baseline) and added a monitor (99% recall, 90% precision) plus a "watch mode" that pauses when the user leaves the page [5].

6. **Sessions that survive restarts.** Three mechanisms, increasing in strength: `storageState` JSON (cookies + localStorage; Playwright warns it "may contain sensitive cookies … used to impersonate you") [15]; a persistent `--user-data-dir` profile, the Playwright MCP default ("A persistent profile can only be used by one browser instance at a time") [1]; attaching to the user's real browser via extension or `--auto-connect` [1][16]. Safety ceiling: Chrome 127's App-Bound Encryption "strongly binds the encryption key to the machine, so will not function correctly in environments where Chrome profiles roam between multiple machines" [17]. VM snapshots keep logins within one VM lineage, not across hosts.

7. **The site-side future is declared tools.** Chrome's WebMCP (early preview, Feb 2026) adds a declarative API for forms and an imperative one for JS, "enabling more reliable and performant agent workflows compared to raw DOM actuation" [18]. Cloudflare's Web Bot Auth signs requests with Ed25519 keys so a site can verify an agent instead of challenging it [11]. Both reward being a *known* agent, not a stealthy one.

8. **Every browser tool is a large capability.** Playwright MCP: "not a security boundary"; its `--secrets` redaction is "a convenience and not a security feature" [1]. Anthropic's guidance: dedicated VM, no credentials in the model, domain allowlist, human confirmation for consequential steps [3][9].

## How grokbot does it (from lecture notes)

Their ladder: memory → connector API → web search → **its own signed-in browser** → full desktop → ask the user; each rung slower, costlier, riskier. Inside the browser rung, "read the page structure" (buttons, links, fields as a list, clicked directly) is the fast path; pixels are for desktop apps and system dialogs; at logins, 2FA, captchas or payments it stops and hands the screen over. A separate computer-use helper does the clicking so screenshots never enter the main conversation. Logins persist because the agent's Chrome lives in a Firecracker VM whose disk is snapshotted when idle.

Mapped to published practice: "page structure" = a11y/DOM refs (1); "click pixels" = computer tool as fallback (2); "ask a person" = takeover/watch mode plus confirmation (5–6); "helper does the clicking" = the one pattern with no strong published equivalent, and the direct answer to the token bill in 3; "VM snapshot keeps logins" = persistent profile, bounded by ABE (6).

## Mason applicability

**Already present.** `bash` runs through `pi-env` (`src/server/env.ts:53`, `vendor/pi/packages/durable/src/tools/bash.ts:145`), so any CLI browser works with zero new tool surface. `ExecutionEnv` is `FileSystem & Shell` only, no PTY (`vendor/pi/packages/durable/src/env/index.ts:373`). pi-env gives each command a fresh process group, SIGKILLed on timeout/abort (`vendor/pi/packages/env/docs/semantics.md:53`); the daemon exits after 30s idle (`vendor/pi/packages/env/docs/protocol.md:64`) [20]. SSH has "no forwarding of any kind" (`vendor/pi/packages/env/README.md:32`), so the browser must live *inside* the environment, never behind a forwarded CDP port. MCP client code exists (`vendor/pi/packages/mcp`) and the coding-agent has an MCP extension, but pi-durable's harness has none; mason composes durable extensions (`src/server/runtime.ts:33`), so Playwright MCP cannot be dropped in as-is. `agent-browser` 0.38.2 is installed here and already used by mason's dev loop (`docs/UI-PLAN.md:139`): CDP, `@eN` snapshot refs, `--profile`/`--restore`/`--auto-connect`, auth vault, `confirm`/`deny`, `mcp` stdio mode [16].

**Missing.** (a) A browsing policy/skill: ladder, stop points, snapshot hygiene. (b) A lifecycle answer for a long-lived Chrome — a backgrounded process can outlive the daemon connection (measured), so nothing reaps it if unmanaged. (c) A user-handoff primitive: hooks and the web UI exist, but no "ask the user and wait" tool. (d) Screenshot rendering (`src/web/components/ToolRow.tsx` is text-only).

**Fits pi's model.** One `bash` call per browsing action, or a single `browser` tool taking a small command object — not 72 declared tools. Screenshots go to files and are referenced by path, matching Chrome DevTools MCP's "reference over value" principle [2] and pi's spill-to-file behaviour. Browser-use cloud is the outsourced option: fastest to working sessions behind bot walls, but credentials, profile and ToS exposure sit outside mason's boundary.

## Mechanism comparison

| Mechanism | Reliability | Token cost / step | Safety | Maintenance |
|---|---|---|---|---|
| A11y/DOM refs (Playwright MCP, `take_snapshot`, `agent-browser snapshot`) | High on forms/tables; breaks on canvas, virtualized lists | 3.5–14k tool snapshot (measured); raw AX 1–6k; `-i` helps | Good: no pixels of secrets; refs go stale | Low; schema churn (72 tools) |
| Raw DOM/JS (`eval`, `innerText`, `read`) | High for reading, brittle for acting | 1–15k, page-dependent; needs truncation | Reads page JS; same-origin limits | Low |
| Screenshot + coordinates (CU tool, Operator) | Weakest precision (46% grounding [6]); universal coverage | ~1.5k/screenshot, grows with history [9] | Worst: pixels leak secrets; image-borne injection | High |
| Hybrid DOM+vision (browser-use, SeeAct) | Best on hard pages; two codepaths | 2–5k | Medium | High |
| HTTP/API first (fetch, connector, search) | Highest where an API exists | 0.1–1k | Best: no session | Lowest |
| Site-declared tools (WebMCP) | Highest when offered | Low | Good: explicit contracts | New [18] |
| User's real browser (extension / `--auto-connect`) | High on logged-in flows | Same as refs | Best fingerprint, worst blast radius | Medium |
| Cloud stealth browser (browser-use cloud) | High on bot-walled sites (vendor claims) | +$0.02/browser-hour [12] | Credentials leave your boundary | Low; lock-in, ToS risk |

## Recommended actions

1. **[now]** Add a `browsing` skill: ladder (known facts → API/fetch → search → `agent-browser` → screenshot → ask user) and stop points (login, 2FA, CAPTCHA, payment, send/post). Load only when browsing starts.
2. **[now]** Standardise on `agent-browser` through `bash`: `snapshot -i` to act, `read`/`eval` to read, `--json` for parsing, `batch` for multi-step work. Cap every observation (scoped selector, `head`/`cut`, or spill to a file) and verify on one real task with recorded token counts.
3. **[now]** Keep the profile under mason's data dir, one session per conversation; test login survival across `npm run dev` restart; add idle-close so orphan Chrome cannot accumulate.
4. **[next]** Add one `browser` durable tool (command + args, text result, screenshots as paths) so tool rows read as one action each. Keep the tool count flat.
5. **[next]** Add a handoff tool: pause, surface the live URL through the web UI, wait for 2FA/CAPTCHA, continue. This is grokbot's "ask a person" and the published mitigation [5][13].
6. **[next]** Decide the long-lived-browser story: a supervised Chrome per environment (started outside the tool call, CDP on localhost, CLI inside) or per-task launch with a warm profile. Never rely on SSH-forwarded CDP.
7. **[later]** Evaluate `chrome-devtools-mcp`/Playwright MCP for dev/debug conversations only, exposed as codemode/deferred, never `direct` [10].
8. **[later]** Track WebMCP and Web Bot Auth: "call the site's tools / prove you are an agent" replaces "browse like a human" [18][11].
9. **[don't]** Declare a 59–72-tool browser MCP server to mason's main conversation.
10. **[don't]** Build a screenshot-first computer-use loop; mason has no VM desktop and the evidence favours structure.
11. **[don't]** Copy Chrome profiles or cookie jars between machines, or put passwords in memory/prompt — ABE breaks the first; the model should never see the second [17][1].

## Open questions

- No head-to-head benchmark isolates representation (a11y vs screenshot) at equal model and token budget; reliability claims here are structural plus per-system evaluations.
- Per-task token usage of Playwright MCP and Chrome DevTools MCP is unpublished; my numbers are single pages on `agent-browser` 0.38.2, not trajectories.
- Whether `agent-browser`'s auth vault encrypts secrets at rest was not verified (binary only) — check before relying on it.
- OpenAI's post-Operator ChatGPT agent internals could not be read: `openai.com`, `developers.openai.com`, `help.openai.com` return 403 here. Only the Operator system card was usable.
- `docs.claude.com` and `claude.com` are unreachable here (DNS sinkhole); Anthropic guidance came from the official `anthropics/anthropic-quickstarts` repository instead.

## Sources

1. https://github.com/microsoft/playwright-mcp — README (features, CLI-vs-MCP, 72 tools, profile/isolated/extension, `--secrets`, security note); read 2026-10-18.
2. https://github.com/ChromeDevTools/chrome-devtools-mcp — README, `docs/tool-reference.md` (59 tools, `take_snapshot`, `take_screenshot`), `docs/design-principles.md`, `docs/cli.md`.
3. https://github.com/anthropics/anthropic-quickstarts/tree/main/browser-use-demo — README (Playwright tool, `ref` targeting, Google CAPTCHA note).
4. https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/ — `getFullAXTree`, `queryAXTree`, `getPartialAXTree`.
5. https://cdn.openai.com/operator_system_card.pdf — Operator System Card (screenshots, watch mode, refusals, injection numbers, OSWorld 38.1%).
6. https://arxiv.org/abs/2401.01614 — SeeAct (grounding gap, SoM ineffective, HTML+visuals best).
7. https://arxiv.org/abs/2401.13919 — WebVoyager (59.1% on live sites).
8. https://arxiv.org/abs/2307.13854 — WebArena (a11y-tree observation, 14.41% vs 78.24%).
9. https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-best-practices — README (1,500 tokens/screenshot, caching, image pruning, safety).
10. `vendor/pi/packages/coding-agent/src/extensions/mcp/index.ts`; `vendor/pi/packages/coding-agent/docs/mcp.md`; `vendor/pi/packages/durable/src/tool-search/index.ts`.
11. https://developers.cloudflare.com/bots/concepts/bot-detection-engines/ ; https://developers.cloudflare.com/bots/concepts/bot-score/ ; https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/.
12. https://docs.browser-use.com/cloud/browser/stealth.md ; https://docs.browser-use.com/cloud/browser/captcha-handling.md.
13. https://docs.browser-use.com/cloud/guides/2fa.md ; https://docs.browser-use.com/cloud/agent/human-in-the-loop.md.
14. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas — canvas is "just a bitmap", not exposed to accessibility tools.
15. https://playwright.dev/docs/auth — `storageState`, state-file warning.
16. `agent-browser 0.38.2` (local binary, NixOS): `--help`, `snapshot`/`-i`/`-d`, `read`, `--profile`, `--restore`, `--auto-connect`, `auth`, `confirm/deny`, `mcp`; token measurements run 2026-10-18 on HN and the playwright-mcp GitHub page.
17. https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html — App-Bound Encryption, Chrome 127.
18. https://developer.chrome.com/blog/webmcp-epp — WebMCP early preview, 2026-02-10.
19. https://blog.cloudflare.com/code-mode/ — code mode vs direct MCP tool exposure.
20. `vendor/pi/packages/env/docs/protocol.md:64`; `vendor/pi/packages/env/docs/semantics.md:53`; `vendor/pi/packages/env/README.md:32`; `src/server/env.ts`; `src/server/runtime.ts`; `vendor/pi/packages/durable/src/env/index.ts`; `docs/UI-PLAN.md`.
