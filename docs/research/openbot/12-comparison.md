# mason vs openbot, dimension by dimension

One verdict table, then a section only where there is a decision to record. `(report NN §section)` is openbot,
`path:line` is mason; report disagreements get their own table. No mason source modified.

## Verdicts

| # | Dimension | mason | openbot | Verdict |
|---|---|---|---|---|
| 1 | Runtime and loop | pi-durable, one loop | AG-UI over a Postgres queue | **mason ahead** |
| 2 | Identity and tenancy | one owner, device tokens, roster | one org, Better Auth, `admin\|user` | **differs by design** |
| 3 | Persistence | SQLite, split home | one Postgres, 92 tables, vendor transcripts | **mason ahead** |
| 4 | Tool surface | one MCP client, deferred, codemode | plugin store, Composio/Arcade | **mason ahead** |
| 5 | Triggers | signed envelope, one hook, dedupe | routines, responsibilities, queue | **mason ahead** |
| 6 | Memory and learning | profile/log/skills git repo | memory rows, vendor learning | **mason ahead**; openbot on learning |
| 7 | Web UI | projection, Chord, widgets | five endpoints, two authorities | **mason ahead** |
| 8 | Desktop and mobile | none; mobile-ready web | Tauri + Expo | **openbot ahead**, narrowly |
| 9 | Deployment | mount boundary, internal networks | all-in-one/compose/helm, root in compose | **differs by design** |
| 10 | Security | token gate, HMAC door, sealed env | vault, approvals, audit | **openbot ahead** |
| 11 | Operations | restart to change config | migrations, CronJobs, HPA, SPIRE | **differs by design** |

## 1. Agent runtime and loop — mason ahead

A mason turn is one `conversation.submit` — `followUpMode: "all"`, steering `one-at-a-time`, selection repaired before
`harness.resume()` (`src/server/runtime.ts:286-287`; `docs/SPEC.md` §3.4) — and only a hook's fire supplies a
`requestId`, so a fire has an identity across a restart while a person's turn has none (`src/server/hooks.ts:176-188`;
`src/shared/contract.ts:186-196`). An openbot turn is an AG-UI run to the Bot's endpoint where **the tool loop runs
outside the server**, so governance rides a signed run assertion and a nonce-bound callback (report 04 §What the server
puts around every remote run). openbot names the cost: "the run ends before a frontend tool runs" (report 02 §Decisions)
— hence suspension, resume, `waiting` statuses, a callback route. One loop is one place a tool result can come from;
openbot's prize is throughput across replicas, which mason does not need.

## 2. Multi-user identity and tenancy — differs by design

mason: one owner, a token spent into an `HttpOnly` cookie, devices revoked without a restart, a roster of names
(`docs/SPEC.md` §4.1b; `src/server/auth.ts:355`). openbot: Better Auth, roles `admin|user`, SCIM groups, capability gates at
`/api/*` (report 10 §Identity). openbot's side is thinner than its names — no `organizations` table,
`channels.allowed_groups` read by nothing (report 02 §Multi-tenancy seams, #82), `users.groups` documented against its own
code (report 10 §Identity). A claimable name with an honest comment (`src/server/roster.ts:8-12`) beats a role model with a
dead column, at a cost named below.

## 3. Persistence — mason ahead

mason: SQLite at `service/data/agent.sqlite` (`docs/SPEC.md` §3.4), the home split so a prompt bug cannot reach `service/`
(`docs/adr/0002-split-home.md`), memory as files in a git repo. openbot: 92 tables in 24 schema files, 61 migrations, blobs
as `bytea` because a volume "would split the backup story in two", and a backup unit that is a `pg_dump` plus
`KEY_ENCRYPTION_KEY` — excluding the conversations, which are vendor threads (report 03 §What a self-hoster must back up).
Mason is ahead because the backup unit is a tree a person can diff; report 03 §Mason-relevant agrees ("**SQLite is right for
mason**").

## 4. Tool surface and integrations — mason ahead

One `McpClient` over Streamable HTTP per enabled integration, every tool deferred, `tool_search` to promote, codemode to
call without declaring (`src/server/mcp.ts:5-13`, `:314`; `src/server/extensions/codemode.ts:5-8`). openbot keeps 14.9k
lines of per-vendor connectors — Composio 2,118 + 1,906, Arcade 693 + 1,806 — against "one MCP client and one event door"
(report 01 §Mason-relevant), so the property mason states, that one module speaks MCP outward (report 10 §Mason-relevant),
openbot cannot. It is ahead on one axis: `plugin_grants` is keyed per Bot (report 10 §Grants), where mason's surface is per
boot and shared — with one bot, a row without a reader.

## 5. Event and trigger path — mason ahead

mason's door: one path, one versioned envelope, HMAC over the raw bytes, `id` → `explicitRequestId`, dedupe with no
seen-ids table because the durable log never forgets an id (`src/server/events.ts:23-112`; `src/server/hooks.ts:274`).
openbot has four deferred paths over one queue — routines keyed on the ISO minute, responsibilities verifying each
vendor's signature, proactive runs, handoffs — each re-supplying what a browser supplied, each with its own retry rules
(report 02 §Proactive, routines, scheduling). Ahead because a new sender is configuration. openbot is ahead on scheduled
fires: its sweep is a CronJob (report 05 §Secrets, migrations, crons, health, scaling); mason's is a `setInterval`
(`src/server/hooks.ts:212-220`).

## 6. Memory and learning — mason ahead on memory, openbot ahead on learning

mason's resident core is `profile.md` plus the log, tail reached by search — the shape the research converged on
(`GLOSSARY.md`; `docs/research/grokbot-insights/03-file-based-memory.md` §Summary). openbot keeps memory as rows — a
`personal_memories` row holds content, provenance and `review_state` per person and per Bot, and a confirmed row mirrors
to Intelligence with a content digest (report 02 §State and memory); report 03 §Mason-relevant names only provenance as
local, describing the mirrored state rather than the only copy. It wins one sub-dimension: a demonstration is a
ten-minute, 200-action, coordinate-free recording with labels redacted, drafted into a skill that grants nothing (report
03 §Demonstrations) — "watch me do it" to prose, a path mason lacks, and a learning loop worth taking without the
vendor.

## 7. Web UI — mason ahead

mason sends three cells — `transcript` and `queued` (`src/server/projection.ts:79`, `:205`), `agentStatus` made in
`src/server/main.ts:157` by `deriveAgentStatus` (`src/server/status.ts:63`) — over one Chord socket; a new entry kind
stays invisible until the projection names it (`docs/SPEC.md` §4.1a). openbot needs REST + React Query + a roster socket
+ the runtime + a history endpoint with a 1500 ms deadline, and two authorities over one transcript with a repair layer
between them (report 06 §Streaming and chat state). It ships AG-UI messages — tool calls, arguments, results — to the
browser, then defends the screen with a folding heuristic (report 07 §Interaction patterns). Worth taking: components
declaring model-facing metadata beside their renderers, found by glob (report 06 §Mason-relevant).

## 8. Desktop and mobile — openbot ahead, narrowly

openbot's Tauri shell is 42.6k lines of Rust doing setup, host-access brokering and OAuth — most of which mason has as a
seam, since every tool crosses a process boundary (report 08 §Mason-relevant). Its Expo app is a second client with its own
auth and release train. Together they buy one thing: an installable client with native push, because openbot's web
app ships no manifest and no service worker, and iOS Web Push needs the app installed (report 09 §Does a native shell
buy...). mason's gap is smaller than "no app": a manifest, a service worker, a Web Push subscription over the transcript
already rendered (`src/web/index.html:5`).

## 9. Deployment and isolation — differs by design

mason is two containers sharing a volume and nothing else: `agent/` mounted into the tool machine, `service/` deliberately
absent, `mason-internal`, `mason-mcp` and `mason-egress` all `internal: true`, one loopback port, uid 1000 on both images
(`deploy/compose.yaml:26-30`, `:77-80`, `:277-301`). openbot needs an all-in-one s6 image with three `EMBEDDED_*`
switches, a Docker-socket supervisor, three Helm computer modes, uid 1001, Chromium `--no-sandbox`, root computer
containers in compose — floors its own chart names (report 05 §Sandbox posture). The designs differ because openbot must
contain a shell it did not write, per Bot.

## 10. Security model — openbot ahead

mason's door is narrower: token → `HttpOnly` cookie, an Origin gate, `env -i` allowlisting, `service/` invisible to
every tool (`docs/SPEC.md` §4.1b-c). openbot's is an operations department: a vault where revocation is never deletion
and a rotation refusal is audited (report 10 §The credential vault), grants whose absence is the refusal (§Grants: the
per-Bot layer), four ranked decision layers whose top rank is three mandatory safety categories that no rule may waive
(report 02 §Approvals and delivery; report 10 §Approvals), 176 audit event types append-only by Postgres trigger (report
10 §Audit trail). It is ahead because mason has a door and no record: `events.ts` is pure, the accept line lives in
`main.ts`, nothing proves a fire became a turn (report 10 §Open questions).

## 11. Operational surface — differs by design

openbot's operations exist to run Postgres with replicas: 61 migrations under `pg_advisory_xact_lock` with a reachability
check, because drizzle's migrator otherwise walks past unapplied files; a one-shot `migrate` service; three CronJobs with
`Forbid`; HPA off; SPIRE optional; 732 value lines (report 03 §Migrations; report 05 §Kubernetes). mason is one
host where changing the integration set is a restart, which buys a byte-identical prompt prefix between turns
(`docs/adr/0003-integrations-are-services.md`); openbot's replicas cost a fleet.

## Where the reports disagree

| Point | The reports | Side, and why |
|---|---|---|
| Copy the action corridor? | report 01 §Mason-relevant: copy the gateway with audit-before-act and a CEL policy. report 10 §Mason-relevant: nine switches and a policy language are "a large surface for a personal agent". | Report 10, plus report 01's refusal row: the ranker answers four principals; the row is cheap. |
| Copy the Postgres queue? | report 02 §Mason-relevant: copy `for update skip locked` with leases and `attempts`. report 03 §Mason-relevant: SQLite is right; pi-durable gives durable submissions. | Report 03 on storage, report 02 on semantics: `attempts` meaning "may already have had an effect" is a discipline mason lacks. |
| Who caused a turn? | report 01 §Mason-relevant: copy `initiator.kind`; it beats mason's log. report 10 §Mason-relevant: the HMAC is stricter; a sender actor belongs in the payload. | Report 10: no table for a column; a field in the versioned envelope moves with the contract (`src/server/events.ts:50-55`). |
| A widget catalogue? | report 06 §Mason-relevant: the gallery is "a middle ground mason lacks", grants server-side. report 07 §Worth avoiding: tens of thousands of lines of chrome. | Report 06's shape without its server half: metadata beside the renderer, no grants. |
| How many approval layers? | report 02 §Approvals and delivery ranks four — safety requirements, team rules, personal rules, auto-review. report 10 §Approvals enumerates the built-in safety requirements (credentials, security settings, payments) that always ask, and its §Mason-relevant counts those as three approval layers. | Both, at different depths: one gate, four ranks, and the first rank is the three categories no rule may waive. The floor is not a second gate. |
| Where does memory content live? | report 03 §Mason-relevant: content at Intelligence, only provenance local. report 02 §State and memory: a `personal_memories` row carries content, provenance and `review_state`; a confirmed row mirrors to Intelligence with a content digest. | Report 02: it names the schema fields and the mirror. The content is local *and* mirrored, so report 03 describes the copy that leaves, not the only one. |

## Where mason is already right

1. **A projection whitelist, not a filter.** openbot ships AG-UI messages — tool calls, arguments, results — to the
   browser (report 06 §Mason-relevant), then hides the machine with a folding heuristic (report 07 §Interaction patterns).
   `src/server/projection.ts` cannot leak an unnamed kind.
2. **One transport.** openbot needs five endpoints and two competing authorities over one transcript, with
   `repair-history.ts` between them (report 06 §Decisions). Chord carries both on one socket.
3. **The mount boundary as the tenancy answer.** openbot narrows every query to `ownerUserId` because agent secrets share
   Postgres with everything else (report 03 §Mason-relevant). mason's `service/` is not mounted.
4. **One adapter.** openbot carries fifteen engine images — sixteen `agent-*` directories, the sixteenth the browser
   service — and 6,035 lines of Python tests proving they answer the same four requests, plus per-vendor connectors
   (report 04 §What one adapter plus a plugin would avoid). A mason integration is a container, a config entry and a
   secret.
5. **A generic signed door.** openbot hand-codes each ingress and its capability gate allows everything on a deployment that
   never opened the screen (report 10 §Mason-relevant). Mason's is one envelope and a `404` for a disabled integration.

## Where openbot is genuinely ahead

1. **The audit trail.** 176 event types, append-only by trigger, redaction by key name, `unattributed` as a recorded value,
   refusals written before the throw (report 10 §Audit trail). Mason's gap: no refusal or outcome row, nothing recording
   that an accepted fire produced a turn (report 10 §Open questions).
2. **Approvals as a durable gate.** "Ask" suspends the turn; the answer writes an `approval.resume` item whose sweep re-runs
   it, actions fingerprinted so a retry is the same act (report 02 §Approvals and delivery). Mason's gap: no approval
   surface, and inside the tool machine every tool is unqualified.
3. **A reviewed learning pipeline.** Demonstrations become drafts become skills, capped and redacted twice, granting
   nothing (report 03 §Demonstrations). Mason's gap: no capture path, no candidate-review step.
4. **Scheduled work that survives downtime.** Routines are rows claimed by a sweep, with a fatigue rule instead of an alert
   nobody reads (report 02 §Proactive, routines, scheduling). Mason's gap: `setInterval` per process
   (`src/server/hooks.ts:212-220`); a slot missed while down never fires.
5. **Reach.** An installable client with native push, a device row made on opt-in and deleted on sign-out, a receipt that
   removes a dead device (report 09 §Mason-relevant). Mason's gap: no manifest, service worker or push; nothing reaches a
   person away from the tab but Telegram.

## Where mason's decisions look wrong

- **The roster is claimable.** "Any credential that reaches the server can pick any name on the roster and become it"
  (`src/server/roster.ts:8-10`). With a Telegram chat relaying several people, that is the one place mason's log cannot be
  trusted about who spoke.
- **Timers in the process.** A schedule is a hook with `intervalMs`, armed by `setInterval` on boot
  (`src/server/hooks.ts:212-220`). For an agent whose proactive path is schedules, that is the weakest link.
- **Nothing records a refusal.** `src/server/events.ts` returns `{ error }`, the caller answers `400`, the accept path is a
  log line. mason has the pure function but not the row.
- **No way to reach a person without an open client.** Delivery ends at `send_to_user` into the transcript plus one chat
  integration. openbot's `mobile/` exists for that gap; the cheaper half — manifest, service worker, Web Push — is absent
  from `docs/UI-PLAN.md` and `src/web/index.html:5`.
- **Rewriting stored user state on every open.** The startup repair appends missing base extensions because it cannot tell
  a legacy doc from a deliberate narrowing, and `docs/SPEC.md` §3.4 says so with no record of when.
