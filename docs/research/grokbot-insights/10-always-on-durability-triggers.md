# Always-on durability: external triggers, event hooks, message handling — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: pi research subagent (parallel run).

## Summary

Denis's instinct is right for the hard part: pi-durable + Chord already give mason the *durable queue* half of grokbot's server — one FIFO per conversation, one run at a time, exactly-once admission by `requestId`, crash resume of interrupted runs and tasks, and state replication in which a lost signal is harmless because every app re-reads committed state. What is missing is the *edge*: durable timers (mason's hooks are in-process `setInterval`s), trigger→turn mapping and dedup at the webhook, any delivery/channel layer (one channel exists: the web client), priority/batching rules beyond `steer`/`followUp` + `one-at-a-time`, and any snapshot/restore of the execution environment. Nothing here needs a new execution engine: pi-durable's task system is the durable-execution engine (checkpoint + effect sandwich + reopen reconciliation), and the gaps are a small number of concrete app-level pieces.

## Key findings

1. **pi-durable is a single-writer, per-conversation queue — grokbot's "one queue per conversation, one turn at a time" verbatim.** `pi.inbox` is an ordered list of queued submissions; `pi.live.run !== undefined` is exactly "busy"; a run places selected items at `postTools`/`final` boundaries (`vendor/pi/packages/durable/src/harness/inbox.ts:85`, spec §6 `docs/spec.md:2271`). Restate states the same invariant — "only one handler with write access to the state can run at a time per virtual object: queue per key" — and lists "stateful agents… AI chat sessions" as the intended use [6].

2. **Exactly-once turn triggers already exist at the admission boundary.** `admitSubmission` returns the existing submission for a known `requestId`, without writing (`src/harness/submissions.ts:179`). mason's hook does **not** use this: it builds `requestId: hook:${hook.id}:${Date.now()}` (`src/server/hooks.ts` `fire()`), so a retried webhook creates a *new* turn. Published engines put the key at the *producer*: Temporal dedups Updates by Update ID and tells authors to dedup Signals with their own key [1]; Inngest dedups events by producer-set `id` for 24 h and functions by an `idempotency` expression [5].

3. **Interruption and batching are boundary-based, not preemptive.** `whenBusy: steer` joins the *running* run only at a boundary; `followUp` waits for `final`; `reject` throws `ConversationBusy`. Selection is one-or-all per boundary via `steeringMode`/`followUpMode`, default `one-at-a-time` (`src/harness/agent.ts:70`, `src/harness/inbox.ts:85`). So grokbot's "you skip the line" means `abort` + submit to interrupt for real, and several quick messages are serialized into successive turns rather than batched. Engines that batch expose explicit windows instead: Inngest opens a batch on the first event and runs at `maxSize`, timeout, or the 10 MiB cap, while debounce restarts a quiet period and keeps only the last event [3][4].

4. **The durable-execution core (recovery) is real.** Tasks are records with checkpoints; phases are intent → effect → outcome ("effect sandwich", spec §5.2); on reopen `running` tasks go back to `pending` with their checkpoint, `waiting` stays `waiting` (spec §5.1 `docs/spec.md:1840`); missing or incompatible definitions *block* rather than terminalize (spec §5.4); ownership trees give abort cascades (§5.5). `Harness.resume()` is idempotent and only enables scheduling — read-only calls never wake the agent (`docs/spec.md:658`) — and mason calls it on startup (`src/server/runtime.ts`).

5. **No durable timer is exposed to applications.** `TaskRuntime.sleep(until)` exists and compares against the Harness clock (`src/harness/scheduler.ts:1811`), but a sleep is only a *re-entrant* step: nothing persists "wake at 08:00" except the task's own checkpoint, and there is no cron or timer task kind (built-ins are `pi.generation`, `pi.tool`, `pi.compaction`, spec §8). Temporal ships persisted timers — "even if your Worker or Temporal Service is down when the time period completes… the call that is awaiting the Timer will resolve" [2] — plus Schedules with overlap policies (`Skip` default, `BufferOne`, `BufferAll`, `CancelOther`, `AllowAll`) and a catchup window [11]. Claude Managed Agents exposes scheduled deployments (POSIX cron + timezone, jittered, one session per firing, pause/unpause, manual run) [9].

6. **State replication is strictly stronger than "something changed" + sequence numbers.** Chord delivers state members as `snap` → `ops` → `reset` per subscription (`vendor/pi/packages/chord/src/types.ts:27`); ops are structural JSON ops (`["s", path, value]`, `["r", value]` — `src/delta/diff.ts`), a slow peer's pending ops are replaced by a reset of the current value (`src/connection.ts:856`), links are FIFO, and flow control is end-to-end acked (spec §9). Durable's watch buffers at most 100 exact committed frames, then replaces the undelivered suffix with a full value (spec §12 `docs/spec.md:5194`). A client therefore cannot miss *state*, only intermediate transitions — so every UI must be a pure function of the latest value, as `deriveAgentStatus` already is (`src/server/status.ts`). Event-log transports need explicit ids and replay instead: SSE re-sends `Last-Event-ID` on reconnect [10]; Claude's stream documents the pattern — open the stream, list history to seed seen IDs, skip duplicates while tailing [9].

7. **Background-run APIs make grokbot's split explicit: durable server-side run, thin client, explicit cancel.** OpenAI Responses: `background: true`, status `queued|in_progress|completed|…`, `POST /responses/{id}/cancel` for background responses only, `previous_response_id` for chaining; background completion also arrives as a webhook carrying an event `id` and the response `id` [8]. CMA: `idle|running|rescheduling|terminated`, sandbox checkpointed on idle and resumable (kept 30 days), `user.interrupt`, budget cap → `idle` with `stop_reason: budget_reached` [9]. Pi-durable's equivalents are `pi.live.run`, `Conversation.abort()`, and SQLite-backed conversation state.

8. **Multi-channel is a *product* layer, and the closest published reference agent is Inngest's Utah.** Channels normalize heterogeneous webhooks (Telegram/Slack/Discord/WhatsApp) into one `agent.message.received` event carrying `{sessionKey, channel, destination, channelMeta}`; the agent function is `singleton: {key: "event.data.sessionKey", mode: "cancel"}` (one run per chat, a new message cancels the current one); the reply is emitted as `agent.reply.ready` and delivered by a separate function; scheduled work lives in agent-authored functions hot-loaded by a sidecar [7]. That is grokbot's app↔server↔computer split built from a durable engine, and it maps onto Chord + pi-durable almost one-to-one: channel adapter → `Conversation.submit`; reply → `SendToUser`-style delivery.

## How grokbot does it (from lecture notes)

Apps are thin; the server owns the loop and the queue; the execution environment is elsewhere. A send is (1) local echo with a client-generated unique ID, deduped by the server, (2) enqueue into the conversation's FIFO, one turn at a time, every step persisted, (3) a payload-free "something changed" signal to every app, which then fetches, (4) sequence-numbered updates so each app converges, a missing number forcing a reload. Interruption is asymmetric: *the* user skips the line; Slack threads, helpers, routines and batched quick messages go to the back. Waking is cheap because the machine sleeps between turns, so triggers are the normal way work starts, not an exception.

## Mason applicability

**Already there (verified in source).** One queue per conversation and one run at a time (`pi.inbox`, `pi.live.run`, `src/harness/inbox.ts`); exactly-once admission by `requestId` (`src/harness/submissions.ts:179`); durable resume of interrupted runs (`harness.resume()` in `src/server/runtime.ts`, task reconciliation in spec §5.1); triggers are durable transcript entries with kind `app.hook` (`src/server/hooks.ts`), so a client that missed the signal still sees the fact; Chord replays whole committed state to every tab instead of sequence numbers (`src/server/main.ts` `viewResource` → `self.state("view", …)`); background triggers queue behind live work (`whenBusy: "followUp"`); a failed run is re-armed by an explicit, testable policy (`src/server/run-retry.ts`); the harness/execution split is exercised for real (`RemoteExecutionEnv` over one `Connection`, `src/server/env.ts`).

**Missing, in priority order.**

1. *Durable timers/schedules.* Hooks persist only `enabled`/`lastFiredAt`/`fireCount` to `.data/hooks.json`; the interval is a `setInterval` armed in-process (`src/server/hooks.ts` `#arm`), and `intervalMs` is code, not state. A restart, or a window missed while the host is down, silently skips a fire: no cron, no timezone, no catchup policy.
2. *A trigger contract.* The only inbound trigger is `POST /api/hooks/:id/fire` with an optional `message`/`data` string (`src/server/main.ts`) — unauthenticated, unvalidated, non-idempotent, and unable to express source, priority or target conversation. `acceptWebSockets(..., { principal: () => ({ kind: "owner" }) })` makes every socket the owner too.
3. *Delivery/channels.* One channel (web) and one conversation (the root, `runtime.conversation()`): Slack/email/web cannot show "the same conversation", and sources cannot be told apart.
4. *Priority and batching.* Only `steer`/`followUp`; no debounce window for quick messages, no per-source priority (a routine and the human are equal in the FIFO).
5. *Execution-environment lifecycle.* pi-env is a real boundary and survives daemon restarts (the client re-opens watchers and reports `overflow`, `vendor/pi/packages/env/docs/semantics.md`), but it has no idle detection, no snapshot/restore, no per-conversation machine; "logins and installed tools survive" holds only as long as the target filesystem does.
6. *Supervisor state is volatile.* `RunRetrySupervisor` keeps `#attempts`/`#handledErrorId`/its timer in memory (`src/server/run-retry.ts`), so a restart resets the retry budget; a durable version is a task with a checkpoint.

**Deliberately do not build.** A second execution engine (Temporal/Restate/Inngest) behind pi-durable; payload-carrying signals (the committed view already carries data); numeric sequence numbers on Chord state (resets already converge, and "reload from the database on a gap" costs a whole round-trip); a Firecracker-style VM snapshot for now (pi-env + a durable filesystem is enough until a real container target exists).

## Recommended actions

1. **[now] Make hook firing idempotent.** Give `HooksManager.fire()` a caller-supplied `requestId`, pass it to `conversation.submit`, and change the default from `hook:${id}:${Date.now()}` to `hook:${id}:${payloadHash}` so a retried webhook is one turn (`src/server/hooks.ts`, `src/harness/submissions.ts:179`). Persist `lastRequestId`/`lastFiredAt` in the state file.
2. **[now] Harden the trigger endpoint.** Token auth on `POST /api/hooks/:id/fire`, a body schema (source, payload, target conversation, `requestId`, priority), and a response carrying the submission ID for retry by the caller.
3. **[next] Move schedules into a durable task.** Define a `mason.schedule` task kind (checkpoint `{hookId, nextFireAt}`) that loops `runtime.sleep(nextFireAt)` → submit → checkpoint the next fire time; `openAgentRuntime` arms one task per enabled hook. This is the only change that makes triggers survive downtime, and it gives catchup semantics for free. Replace `intervalMs` with `cron`+`timezone` evaluated to `nextFireAt`.
4. **[next] Add per-source admission policy.** An `origin: "user" | "hook" | "channel" | "helper"` field on submissions, with the grokbot rule *user interrupts, everything else queues*: map the user to `steer` mid-run, everything else to `followUp`. Then set `steeringMode`/`followUpMode` deliberately in `openAgentRuntime`'s `settings` and document the choice (`src/server/runtime.ts`).
5. **[next] Batch quick messages with a debounce, not with a queue mode.** Hold an idle conversation's first input for ~2 s (`PDA_BATCH_WINDOW_MS`), append later inputs to the same batch, submit once. The cheap interim: `followUpMode: "all"` plus a note that a burst landing before a `final` boundary is answered in one turn.
6. **[later] Introduce a channel/delivery layer, one conversation per channel.** `Channel = { id, destination, inbound(text) → submit, outbound(entry) → deliver }`, driven by a server-side watch on committed entries (the `app.hook`/`pi.assistant` boundary already exists), with per-channel `ConversationId`s instead of the single root; web becomes one channel among several. Model it on Utah's normalization + `singleton(key: sessionKey)` [7].
7. **[later] Persist the retry supervisor.** Replace `RunRetrySupervisor`'s in-memory counter with the durable task shape of (3), reading the failure out of the transcript.
8. **[later] Expose trigger status on `/api/status`** — next fire time per hook, last outcome, queued count — so a wedged scheduler is visible without the debug sheet.
9. **[don't] Add sequence numbers to the Chord view or a poll-on-signal fetch path**; the client already converges from whole committed values.

## Open questions

- Chord converts pending ops to a reset when a peer is slow (`src/connection.ts:856`), but the spec does not state whether a *remote* subscriber can ever apply ops to a value it never held after a reconnect; I read resubscription as always producing a fresh snapshot/reset but found no test asserting it.
- Whether `steer` can preempt an in-flight generation (abort + restart with the new message) without a user-visible partial answer; the spec defines placement at boundaries only.
- Real dormancy: neither pi-env nor pi-durable models "host asleep"; the closest anchor found is Claude's 30-day sandbox retention [9].
- Temporal's `CancelOther`/`TerminateOther` has no verified pi-durable equivalent beyond `Conversation.abort()`; unclear whether abort reaches a successor run's queued items.

## Sources

- `vendor/pi/packages/durable/docs/spec.md` (sections 2.2, 5.1–5.5, 6, 8, 9.4, 12)
- `vendor/pi/packages/durable/src/harness/{inbox.ts,submissions.ts,agent.ts,scheduler.ts,events.ts}`
- `vendor/pi/packages/chord/docs/spec.md`, `vendor/pi/packages/chord/src/{connection.ts,cell.ts,remote.ts,types.ts,delta/diff.ts}`
- `vendor/pi/packages/env/docs/{protocol.md,semantics.md}`
- `src/server/{main.ts,hooks.ts,runtime.ts,run-retry.ts,status.ts,env.ts}`, `src/shared/contract.ts`, `docs/SPEC.md`
- [1] https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow-message-passing/handling-messages.mdx
- [2] https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow/workflow-execution/timers-delays.mdx
- [3] https://raw.githubusercontent.com/inngest/website/main/pages/docs/durable-execution/flow-control/debounce.mdx
- [4] https://raw.githubusercontent.com/inngest/website/main/pages/docs/durable-execution/flow-control/batching.mdx
- [5] https://raw.githubusercontent.com/inngest/website/main/pages/docs/durable-execution/guides-and-advanced/idempotency.mdx
- [6] https://raw.githubusercontent.com/restatedev/documentation/main/docs/concepts/services.mdx and …/durable_execution.mdx and …/durable_building_blocks.mdx
- [7] https://raw.githubusercontent.com/inngest/utah/main/README.md, …/src/functions/message.ts, …/docs/channel-event-normalization.md, …/workspace/functions/example-cron.ts
- [8] https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.yaml (`/responses/{response_id}/cancel`, `WebhookResponseCompleted`)
- [9] https://raw.githubusercontent.com/anthropics/launch-your-agent (README.md, cma-primitives.md — public Claude Managed Agents docs, distilled)
- [10] https://raw.githubusercontent.com/whatwg/html/main/source (server-sent events: `Last-Event-ID`, reconnection time)
- [11] https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow/schedule.mdx (overlap policy, catchup window, backfill)
