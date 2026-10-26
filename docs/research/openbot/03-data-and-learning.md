# Persistence, learning, telemetry

## What it is

OpenBot keeps its product state in one PostgreSQL database: 92 tables in 24 Drizzle schema files
(`server/src/db/schema/index.ts:1-25`), 61 SQL migrations (`server/drizzle/`), and no second store
except the tenant package on disk. Transcripts and memory are the exception — they live at CopilotKit
Intelligence, with pointer tables here. "Learning" is a remote vendor feature pointed at by two local
tables; "demonstrations" is a local browser recording that becomes a skill row. Telemetry is the audit
trail plus an optional OTLP mirror of it.

## How it works

### The data model

```text
deployment  (one per install; no org/tenant table)
├─ users ─ sessions, accounts, user_roles, user_instructions, revoked_access
├─ agents ─ agent_profiles (visibility, deletedAt), agent_preferences
│   ├─ plugin_grants (kind, ref, agentId)   absence = refusal
│   ├─ routines ─ routine_runs     responsibilities ─ responsibility_events/runs/triggers
│   └─ memory_sources ─ personal_memories (per person AND per bot)
├─ channels ─ channel_memberships (pinnedAt, lastReadAt), attachments(bytes), voice_sessions
├─ audit_events  (append-only, trigger-enforced)
├─ work_items    (kind, key) durable queue shared by every replica
└─ admin: capability_settings, enterprise_settings, network_policies, action_records, model_usage
```

Three grains, applied deliberately rather than uniformly: deployment rows carry no owner, person rows
key on `ownerUserId` and cascade from `users`, bot rows carry `agentId`. Where two collide the code
splits the fact: a channel's last message is channel grain (`core.ts:310-319`) while a pin and a read
marker are membership grain (`core.ts:370-392`), each with a comment saying a per-member copy would
drift. There is no `organizations` table and no `tenant_id` on any product row; the only `tenantId` is
the package identity (`core.ts:261-269`). One deployment is one organisation, enforced by deployment
rather than by predicate — which is why an Activity query can start from `actor.id` and be safe.

Two choices matter. `plugin_grants` has no `enabled` column (`plugins.ts:786-800`), so a
missing row resolves to "not granted". Attachments are `bytea` because a volume "would split the
backup story in two" (`core.ts:508-517`).

### Migrations

`drizzle-kit` generates SQL only; the runtime uses `scripts/migrate.ts`, because the CLI is a dev
dependency a production image cannot compile (`migrate.ts:1-21`). `applyMigrations` takes
`pg_advisory_xact_lock('openbot:apply-migrations')`, checks every migration file is still *reachable*,
then migrates, all in one transaction (`apply-migrations.ts:114-140`). The reach check exists because
drizzle's migrator reads one row, `order by created_at desc limit 1`, and a NULL `created_at` sorts
first: a database that ran a renumbered branch's journal silently walks past migrations it never
applied and reports success (`migration-reach.ts:1-30`, `:132-152`). It refuses rather than repairs.

Compose runs a one-shot `migrate` service before anything serves (`docker-compose.yml:46-67`). Helm
uses a pre-install/pre-upgrade Job, except on a first install with the bundled database, where it must
be an ordinary Job or the hook deadlocks against a database that does not exist yet
(`charts/openbot/templates/migrations/job.yaml:1-25`).

### Activity

Two things share the word. The browser tab is live and ephemeral, "a window rather than a record"
(`docs/architecture.md:157-160`). The server's Activity store writes nothing: it reads six existing
ledgers — routine runs, responsibility runs, the hop queue, approvals, questions, follow-ups — because
a second ledger "would drift from the first the moment one of them gained a state"
(`activity/activity.ts:1-9`). Items carry `needsYou`/`stoppable`/`cancellable` per kind
(`activity.ts:31-70`), every query is narrowed to `ownerUserId` first, and `attention()` counts
questions, approvals, failed handoffs and unread channels per bot (`activity.ts:458-545`).

### Learning

Learning is a vendor feature. Locally it is two tables: `learning_settings` (singleton row
`id='current'` holding `{enabled, defaultTarget, agents}`) and `learning_thread_bindings` (person,
thread, bot, container) (`db/schema/learning.ts:5-26`). Evidence collection, analysis and published
skills happen in a CopilotKit Intelligence "container"; the server only points at one
(`docs/automatic-learning.md:3,29`). At run time `selectLearningTarget` resolves bot → container, a
`SkillRegistry` per `(containerId, revision)` is acquired, and the run receives a skill catalog plus
exactly two tools (`learning/runtime.ts:29-48,117-141`). Threads are bound once before creation and
never moved or backfilled (`runtime.ts:145-181`). Auto-assignment probes for a container named
`openbot` every ten minutes (`auto-assign.ts:191`) and never overrides a saved setting.

A whole docs page explains how to get one container created, because a runtime key cannot — only a
browser session, a CLI login, or a service token on a local evaluation install can
(`automatic-learning.md:46-58`).

### Demonstrations

The local learning path. The computer's websocket injects `demonstration.action` messages the server
captures; there is "no public action-upload endpoint" (`demonstrations/recording.ts:11`,
`http-server.ts:186-217`). A recording is capped at ten minutes and 200 actions, enforced twice — a
timer, and an expiry applied on every read so a restart cannot extend it (`types.ts:52-57`,
`store.ts:33-48,151-157`) — and one live recording per bot, by partial unique index
(`db/schema/demonstrations.ts:43-45`).

What it records is deliberately lossy: element role and accessible name, never coordinates, never
typed values, with `sensitive` a flag on the target rather than the content
(`agent-computer/src/demonstration.ts:100-140`); long tokens and emails in labels become `[redacted]`.
Drafting turns actions into an instruction document — one numbered step per action, a fresh snapshot
and current reference rather than recorded coordinates, sensitive fields handed back to the person to
type, non-sensitive typed fields as `{{input_n}}` parameters (`demonstrations/draft.ts:6-79`).

The artifact is a `skills` row (`plugins.ts:704-742`) plus a `skillSlug` back-reference. A skill grants
nothing — the firewall is at the tool call, not the prose (`plugins.ts:698-703`) — so anyone signed in
may author one, and a published demonstration runs on a schedule by creating an ordinary routine
(`demonstrations/schedule.ts:1-20`).

### Telemetry

Four streams; only one leaves the deployment by default.

1. **`audit_events`** is the record: one row per click, tool call, refusal, command, sign-in
   (`core.ts:431-487`), append-only by trigger with UPDATE and TRUNCATE refused outright
   (`drizzle/0007_audit_retention_window.sql`, `0012_…append_only.sql`). Payloads are redacted by key
   name before insert, including `content`, `prompt`, `result`, `tool_arguments`
   (`audit.ts:16-47,711-726`).
2. **OTLP export** is a tap on that store, wired only when an endpoint is configured
   (`admin/controls.ts:288-290`, `telemetry/otel.ts:130-140`); `OPENBOT_OTEL_EXPORT=off` disables it
   with an endpoint still set. Every `command` is re-scrubbed on the way out (`otel.ts:80-95`,
   `telemetry/scrub.ts:1-13`).
3. **`action_records`** is a separate scrubbed, 90-day table of shell commands, off unless
   `action_recording` is on (`db/schema/admin.ts:104-135`, `controls.ts:64,296-340`).
4. **Runtime analytics** are CopilotKit's: the runtime gets desktop metadata through
   `telemetryProperties` (`copilot.ts:1786-1792`), and the desktop app has a closed event allowlist with
   `COPILOTKIT_TELEMETRY_DISABLED`/`DO_NOT_TRACK` opt-outs (`desktop/TELEMETRY.md:3`). `model_usage`
   records allowlist outcomes (`db/schema/admin.ts:140-163`).

### Retention and deletion

Retention is opt-in: `AUDIT_RETENTION_DAYS` unset means keep forever (`config.ts:1266-1281`); when
set, one server sweeps hourly under a session advisory lock, 5 000 rows at a time, declaring
`openbot.audit_retention_days` transaction-locally so the trigger permits exactly those deletes
(`audit-retention.ts:56-110`). Everything else is a hardcoded window: page frames 30 days
(`computer/page-frames.ts:27`), staged attachments 24 hours
(`scripts/cull-staged-attachments.ts`), `work_items` per kind. Deletion is mixed by intent: `channels`
and bots soft-delete (`core.ts:331-336`, `coworker.ts:29-66`), and audit rows have no foreign key to
`users` so a person can still be removed (`core.ts:434-440`). Some tables have no retention at all:
`routine_runs`, `responsibility_runs`, `model_usage`, `voice_sessions.transcript`, `demonstrations`.

### What a self-hoster must back up

The claim is one `pg_dump` (`core.ts:514`), plus the secrets that make the dump readable:
`KEY_ENCRYPTION_KEY` (credentials are ciphertext plus a `keyId`, `core.ts:408-429`) and
`BETTER_AUTH_SECRET`. Not in the dump: the tenant package directory, `.env`, each computer's workspace
and profile volumes (`docker-compose.yml:119-122`), and the conversations themselves, which are
Intelligence threads referenced by `intelligence_channel_mappings` (`core.ts:490-505`).

## Decisions and their reasons

**One database for everything, including the queue and the blobs.** Bought: one backup unit, no
coordinator, `for update skip locked` as the whole distributed-queue story (`work.ts:26-33`). Cost: the
largest table is written by every action (`core.ts:445-462`), and blobs sit on the API's hot path.
**The trail is append-only inside that database**: retention becomes a policy an operator can state
rather than a promise, at the price of two migrations of trigger surgery.

**Learning delegated to a vendor, demonstrations kept local.** Bought: a real evidence →
candidate → published-skill pipeline without building one, while the local path (a recording becomes
prose that grants nothing) needs no new permission surface. Cost: no learning at all without an
Intelligence project and a container, and a demonstration is a hint to the model rather than replay —
the draft says so itself ("Use only browser actions currently permitted").

**Code disagreeing with docs:** `channels.allowed_groups` and `users.groups` read as an access control
and are not (`core.ts:293-301`, `:71-82`), which the schema comments and
`docs/architecture.md:173-176` both admit. Less honestly, `agent_profiles.visibility` is now joined by
a second sharing model (`team_bot_publications`, `team_bot_audience`, `team_bot_consents`,
`shared_use_approvals`), so "who may use this Bot" takes five tables to answer.

## Mason-relevant

- **Worth copying:** the stated backup invariant covering the whole install, and naming which store is
  the record (audit) and which is a window (browser Activity). Activity as a derived read over existing
  ledgers (`activity/activity.ts:1-9`) applies directly: render it from `log/`, journal and pi-durable
  submissions rather than adding a table. Also the demonstration safety property — a recorded workflow
  becomes a *skill*, never a new tool face.
- **Worth avoiding:** a vendor-owned learning loop as the only path to self-improvement. It needs a
  container, a CLI login and a browser sign-in before it does anything. mason's log → journal →
  profile loop is files the agent can read; keep it that way. Also avoid columns that read as controls
  and are not, and retention windows scattered as literals.
- **Already right in mason:** the `agent/` vs `service/` split (`docs/adr/0002-split-home.md`) buys
  what OpenBot buys with per-row ownership checks, but from a mount boundary — a prompt bug cannot leak
  `service/` at all, whereas OpenBot must narrow every query and comment on it. Files over rows for the
  agent's own memory is the better bet too: OpenBot keeps memory *content* at Intelligence and only
  provenance locally (`db/schema/memory.ts:85-93`). And **SQLite is right for mason**: Postgres buys
  multi-replica claims and a shared queue; mason is one process, and pi-durable already gives durable
  submissions (`src/server/runtime.ts:257`). The cost is that the home — `agent/` plus
  `service/data/agent.sqlite` and the `service/` secrets — is the backup unit, with no single command
  that restores it.

## Open questions

- Where the 1:1 channel transcript lives, and what a channel does when Intelligence is unavailable: the
  schema has `group_messages` for group chats and a thread mapping otherwise, and
  `docs/architecture.md:344-352` covers memory degrading but not threads.
- Whether `deployment_packages` rows accumulate per package version, and whether the `override`
  columns survive it; `synchronizeTenantPackage` would say.
- What happens to `credentials` rows when `KEY_ENCRYPTION_KEY` is rotated rather than the credential,
  and whether anything prunes `voice_sessions`, `routine_runs` and `model_usage`: I found no sweep,
  but absence of a call site is weaker evidence than its presence.
