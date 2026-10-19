# UI Plan — Chat Area (apiary look, pi-durable backend)

Status: draft for review. Scope: chat area only. Author: agent, 2026-10-14.

## 0. Summary of decisions

1. **Take the chat area from apiary** (`DenisSud/apiary` → `packages/web`): turns/bubbles structure, temporary traces, thinking collapsibles, tool rows, streaming tail reveal, append-only DOM behavior, scroll follower + jump pill, composer pill, markdown rules, design tokens — all from `packages/web/src/{turns,transcript,stream,tools,composer,scroll,markdown}.ts` + the chat sections of `style.css`.
2. **One addition to the "traces are not kept" rule:** `generateSandboxedUi` widget cards persist in settled turns. They are the only trace piece that survives settlement; tool rows and thinking still collapse away.
3. **Debug mode** reuses the same transcript and adds every note the durable backend exposes: tool statuses + live output, assistant message badges, system-prompt entries, hook payloads, nested tools, retry/deferred, compaction status/failure, inbox ids, usage ledger, raw state inspector.
4. **Re-implement as React components** (confirmed) on our existing Chord shell (`src/web/client.ts` subscription stays), porting apiary's pure logic and CSS nearly verbatim. apiary's manual append-only DOM diffing is replaced by stable React keys — same emergent behavior (open `<details>` survive, entries animate once).
5. **Out of scope:** sidebar, bot list, onboarding, panel/drawer, blobatars, setup chip, auth. Minimal session bar stays (status + actions), restyled to apiary's session-bar look.
6. **Decided details:** hook triggers render as a full banner in normal mode; the composer has two send actions while busy (**Steer** / **Follow-up**) and one while idle; no skill chips; widget cards render bare (no caption).

## 1. Backend deltas that matter (apiary was built on the old pi service protocol)

apiary's UI consumed a `TranscriptSnapshot` from the old `pi-client`/`pi-server` era. Our backend is `pi-durable`'s `ConversationView`: `{ conversation, entries, docs }`. The mapping, plus what changed:

| apiary concept (`TranscriptSnapshot`) | ours (`ConversationView`) | delta |
|---|---|---|
| `transcript: Entry[]` with `timestamp` per entry | `entries: EntryRecord[]` — `{ id, kind, model?, data?, head?, byTaskId? }` | **No entry timestamps.** Message-level timing only (`AssistantMessage.timestamp`/`durationMs`, `ToolResultMessage.durationMs`). |
| entry kinds: `message` (user/assistant/toolResult), `compaction`, `branch_summary`, `custom` | kinds: `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, `app.hook` (ours), custom | New: `pi.system` sits between user and assistant in every turn — grouping must not flush turns on it. No `branch_summary`. |
| `operation` (busy state) | `docs["pi.live"].run` | same idea; adds `taskId`, `inputs`. |
| `operation.streamingMessage` | `docs["pi.live"].generation.message` (+ `attempt`) | committed throttled partial; streamed tool-call arguments are in it (genui preview already works off this). |
| `operation.runningTools[]` (`running`/`settled`) | `docs["pi.live"].tools[]` (`pending`/`running`/`done`) + `output`, `droppedBytes/Lines`, `details`, `diagnostics`, `taskId` | **Live output streaming is new** — apiary only saw a result once settled. |
| — | `docs["pi.live"].nestedTools[]` | **New:** sub-calls a running tool made via `executeTool()`, with `parentCallId`, own `arguments`/`output`/`summary` (error, duration, usage). |
| `operation.deferred: boolean` | `generation.deferred: { pollAt }` | "Waiting" state with a timestamp. |
| — | `generation.retry: { at, error }` | **New:** visible retry/backoff (apiary surfaced only generic busy). |
| `queues` (steer/follow-up list) | `docs["pi.inbox"].items[]` `{ id, mode: steer\|followUp\|write, content, entry? }` | **New:** durable ids → per-item withdraw (apiary could only restore text to the composer on abort). |
| `compaction` entry note | `pi.compaction` entry + `live.compactions[]` (`reason`, `blocking`, `attempt`, `retry`) + `live.compactionFailure` | **New live status**; failure banner. |
| — | `docs["pi.usage"]` `{ models, tools }` | **New:** per-model/per-tool spend → debug footer. |
| — | `docs["pi.agent"]`, `docs["pi.provider"]` | **New:** model/extensions/tools/cwd; provider session id → debug inspector. |
| — | `app.hook` entries `{ hookId, hookName, payload, firedAt }` | **New:** proactive turns must render (agent speaks first). |
| tool duration computed from entry timestamps | `ToolResultMessage.durationMs` | Simpler: read the message field. |

Also: entries are a **tree on the server** (`fork()`, `head` markers) but the view shows one active path; `pi.compaction`/`pi.reset` entries can replace spans, so the entries list can shrink between updates. React keys handle this; the transcript must not assume append-only.

## 2. Rendering model (adapted from apiary's `turns.ts`)

### 2.1 Blocks

`groupEntries(entries)` → ordered blocks:

- `user` — `pi.user` (turn boundary)
- `hook` — `app.hook` (turn boundary; new kind)
- `turn` — run of `pi.assistant` + `pi.tool-result` (+ `pi.system` kept in-place, rendered only in debug)
- `note` — `pi.compaction` (summary text), `pi.reset` (handoff text), unknown kinds (kind + data summary)

Differences from apiary: `pi.system` does **not** flush a turn (it is the positional prompt marker that lands between user and assistant in every request); unknown kinds become notes (debug-only content).

### 2.2 Pieces

`turnPieces(turn, live.generation?.message, live.tools, live.nestedTools?)` → ordered pieces:

- `thinking` (text)
- `toolCall` / `toolResult` / `toolLive` — maintained apiary pairing via `toolCallId`; `toolLive` covers running slots without a committed call (e.g. after compaction)
- `text`
- **`widget` (new)** — a settled-or-streaming `generateSandboxedUi` call: `{ callId, args, streaming }`
- **`message` (new)** — a settled-or-streaming `send_to_user` call: the text the reader is meant to read, `{ callId, text, streaming, failed }`. A streaming call before its `message` argument arrives is not a piece at all: the call counts as covered, so neither an empty bubble nor a tool row takes its place.

Nested tool slots attach to their parent tool call piece as child rows (debug detail; shown while the parent runs).

### 2.3 Bubbles

`groupBubbles(pieces)` → bubbles, apiary rule kept: a trace piece after produced content opens a new bubble; produced content always lands in the current one. Extended: produced content = `text` **or** `widget` **or** `message`. Bubble shape: `{ key, trace: TracePiece[], widgets: WidgetPiece[], messages: MessagePiece[], text: string }`; render order inside a bubble is `trace → text → messages → widgets`, with delivered messages as blocks of their own beside it (text after one opens a new bubble, and a card never joins one).

### 2.4 Live vs settled vs debug

| | live turn | settled turn (normal) | settled turn (debug) |
|---|---|---|---|
| thinking | `details.reason-row`, open, italic quiet line | dropped | kept as collapsible |
| tool rows | in "Working" trace `details`, open; state glyph spinner/check/alert; live `output` pre (truncated with "show all"); nested children indented | dropped | kept: args + result + status + duration + `byTaskId` + diagnostics + `details` JSON |
| widget cards | rendered in bubble (never inside the collapsing trace) | **kept**, bare | kept, plus raw args JSON |
| text | tail-reveal stream (apiary `stream.ts`) | markdown bubbles | + badge `[assistant · settled · stopReason=… · attempt · durationMs · usage]` |
| delivered messages | own bubble as the call streams (tail reveal), the trace it sits in folding away | **kept** as a bubble of their own | + the call id and the failed/interrupted note |
| trace collapse | animated height→0 when text/widget arrives | — | n/a |
| `pi.system` | — | hidden | row `[system • sections: …]` + tools added/removed |
| `pi.reset` | — | quiet note "session reset" | note + handoff text |
| `pi.compaction` | live `compactions[]` chip (blocking/attempt/retry) | note "compacted" + summary | note + reason + taskId + retry |
| retry / deferred | chips: `[retry in Xs — error]`, "Waiting" | hidden after settle (it settled) | chips + raw values |
| hook entries | — | full banner: hook name, `firedAt`, payload ("agent woke on its own" styling) | banner + `hookId` + prompt text |
| inbox | queued user bubbles, faded, tag `steering`/`follow-up`, withdraw button per item | — | + submission id + mode + entry kind |
| compaction failure | — | hidden | error banner |
| usage | — | — | footer/panel: `pi.usage` models+tools totals |
| raw state | — | — | inspector: `live`, `inbox`, `agent`, `provider` docs as collapsible JSON |

### 2.5 Widget persistence (the exception)

- Widget cards render at the tool call's position in the flow, in both live and settled turns.
- During live, the trace collapse must never take the widget with it: the widget is a sibling of `details.trace` inside the bubble, added as soon as its tool call piece exists.
- Widget card = existing `SandboxedUiCard` wrapped in a `.widget` container; streaming preview while the call streams, final sandbox once settled (already implemented behavior in `src/web/components/SandboxedUiCard.tsx`). **No caption/label** (decided): the card renders bare; debug mode shows the tool row with args above it.
- Errors (`isError` result) fall back to a normal tool row (debug) / nothing (normal).
- Multiple widgets per turn are allowed; order = call order.

## 3. Files

### Ported from apiary (logic, near-verbatim → `src/web/lib/`)

| apiary file | our file | notes |
|---|---|---|
| `turns.ts` | `lib/transcript-model.ts` | adapted to `EntryRecord`; hook block; widget pieces; system-in-turn; no timestamps |
| `markdown.ts` | `lib/markdown.ts` | verbatim |
| `tools.ts` (helpers) | `lib/tool-view.ts` | `summarizeArgs`, `singleLine`, `stepDuration`, icon map (+ `generateSandboxedUi` icon) |
| `stream.ts` | `lib/stream-text.tsx` | same DOM algorithm (settled markdown + fading tail) as a React component |
| `scroll.ts` | `lib/follower.ts` | `pinnedAfterScroll` pure fn + follower class; mounted by the transcript component |
| `style.css` | `styles/tokens.css` + `styles/chat.css` | chat sections only; drop sidebar/drawer/onboarding/blobatar rules |

### Replaced components (`src/web/components/`)

`StatusBanner` → `SessionBar.tsx` (title, status pill idle/busy/error, stop/compact actions, gen-ui toggle, debug toggle; hooks fold into debug).
`TranscriptView` → `Transcript.tsx` (blocks → bubbles; live slot; jump pill wiring).
`ToolRow` → `ToolRow.tsx` (apiary row: icon, `name:`, one-line summary, hover duration, state glyph, expandable args/result; debug extras).
`InboxBar` → `QueuedRows.tsx` (apiary faded user bubbles + tag + withdraw).
`Composer` → `Composer.tsx` (apiary pill math: grow, cap 14 lines, expand 27, send circle, 44px touch collar).
New: `MessageRow.tsx` (user/hook/assistant/note variants), `Trace.tsx` (thinking + tool rows + live output), `WidgetCard.tsx` (wraps `SandboxedUiCard`), `JumpPill.tsx`, `debug/DebugBits.tsx` (badges, inspectors).
Kept: `SandboxedUiCard.tsx` and `lib/{frame-content,process-partial-html,idiomorph-inline,websandbox-loader,open-genui-content}.ts` as-is.
`view-types.ts` extended: nested tools, usage doc, message `timestamp`/`durationMs`/`usage`/`stopReason`, entry `byTaskId`, diagnostics.

### Explicitly skipped from apiary

`session.ts`/`auth.ts`/`onboarding*`/`panel.ts`/`bots.ts`/`blob.ts` (no bots/sidebar), `skill-block.ts` (decided: no skill chips; skills are not wired into the durable harness), `branch_summary` (no such entry), `main.ts` (our `main.tsx` shell stays).

## 4. Actions

`AgentService` stays as-is — the same methods (`submit`, `withdrawSubmission`, `abort`, `reset`, `compact`, `fireHook`, `toggleHook`, `setSandboxedUiEnabled`) plus one added optional field, `fireHook.requestId?`: a caller that already holds an event identity passes it and that fire is deduplicated exactly, while a control pressed in the transcript passes none and is a gesture of its own.

- Composer: idle → one send button → `submit({ content })`. Busy → two send buttons, matching the backend's queue modes exactly (`applyBoundary` in durable: steers at the `postTools` boundary, follow-ups only at `final`):
  - **Steer** → `submit({ content, whenBusy: "steer" })` — placed when the current tool round ends (before the next model step); if the generation produces no tools, it lands at run end.
  - **Follow-up** → `submit({ content, whenBusy: "followUp" })` — placed only when the run ends (the model has finished all its turns).
  Busy placeholder "Steer or follow-up…". Queued bubbles label the mode (`steering` / `follow-up`).
- Stop: `abort()`; queued items stay visible (durable inbox) instead of apiary's restore-to-composer.
- Compact: `compact()` while idle.
- Debug sheet: hook list with enable toggle + "Fire now" (replaces `HooksPanel`), model/cwd display, raw inspectors.
- Widget bridge unchanged: `sendPrompt` → `submit({ whenBusy: "followUp" })`, `openLink` → new tab.

## 5. Phases

1. **Pure model + tests** — `transcript-model.ts`, `tool-view.ts`, `markdown.ts`, follower pure fn; port apiary's `test/core.test.ts` cases and add: system-in-turn grouping, hook turns, widget bubble grouping/persistence, shrink-after-compaction.
2. **Components + wiring** — transcript/message/trace/tool/composer/jump-pill/session-bar on the existing chord subscription; delete Stage-1 components.
3. **Styles** — port tokens + chat CSS, widget card + debug styles, mobile passes at 390px/800px/desktop, dark mode.
4. **Debug mode** — badges, notes, live extras, inspectors; `?debug=1` + localStorage; data-testids on debug rows.
5. **Verify** — `npm test` unchanged, new pure tests, browser pass with `agent-browser` (below).

## 6. Verification (agent-browser)

1. Desktop: send a message with the faux model scripted to run `bash`, `generateSandboxedUi`, then text — assert: working trace → collapse; widget persists; markdown tail reveal.
2. Settled turn shows text + widget, no tool rows (normal), all rows (debug, toggled live).
3. Fire `workspace-check` with faux responses — hook banner visible, proactive answer streams.
4. Busy: send a second message → queued bubble with tag; withdraw → gone.
5. Mobile 390px: composer grows/caps; jump pill appears when scrolled up; touch targets ≥ 44px.
6. Dark mode + `prefers-reduced-motion`.
7. Kill/restart server mid-run → reconnect banner → resumed run streams into the same transcript (durable bonus).

## 7. Decisions log (all resolved)

Resolved (2026-10-14):

1. React re-implementation (not vendoring apiary's vanilla modules).
2. Hook triggers: full banner in normal mode; debug adds `hookId` and the prompt text.
3. Composer: two send actions while busy (**Steer** / **Follow-up**); one while idle. Semantics match the durable backend exactly: steer = next boundary (end of the current tool round), follow-up = final boundary (run end).
4. No skill chips.
5. Widget cards render bare — no caption or label.

## 8. Beyond the port: widget fullscreen

Widgets are meant to be used, not only glanced at: dashboards and controls need the whole screen. Added after the port —
`WidgetCard` owns a `fullscreen` state, `SandboxedUiCard` fills the viewport instead of reporting its content height, and
`frame-content.ts` swaps the sandbox between the measurement layout and a viewport layout (`FULLSCREEN_FRAME_JS`). The
sandbox is not re-created, so widget state survives. Verified at 1280×900 and 390×844 (enter via button, exit via button
and `Esc`, live resize inside the sandbox, bridge submission while fullscreen, no clipped edges).

6. **A widget closes its bubble.** The model writes its lead-in and then calls the tool, and the follow-up answer
   arrives in a message of its own, so `groupBubbles` keeps a widget's own result (and the reasoning that follows it)
   with the card and opens a fresh bubble for a second card. `bubbleContent()` orders a bubble's content text-first,
   widgets last: a card never sits above the paragraph that introduces it.
7. **A failed turn is not a dead end.** The newest turn that ended in a model error carries a Retry control, which
   fires the `retry-failed-run` hook — the same thing the server's run supervisor fires on its own schedule. See SPEC
   §4.4.
8. **Queued submissions wait at the end of the chat, not ahead of the run.** A steer or follow-up submitted while a
   turn runs shows below the working block — where the agent's next input lands once the boundary places it — because
   the run that precedes it cannot matter to its position any more: while it waits it is below the latest text for
   sure, and once placed it enters the transcript below the content the run had already written. The queue shows
   whenever the inbox holds items — after a model error too, so the reader can see what the restart will pick up —
   and the `×` control is a purely display-side rendering of when the durable backend can settle a submission: plain
   queued user inputs withdraw at any time through `withdrawSubmission`; a write or hook-input item has left plain
   text and loses the control.
9. **A widget is a block of the answer, not part of a sentence.** Cards render beside the bubble, at the column's
   width: inside it a widget could only ever be as wide as the line that introduced it, which turned a three-column
   dashboard into one narrow column.

## 9. Beyond the port: a widget that streams without thrashing

The first streaming pass was honest but unpleasant to watch: the card sat at the model's estimated height while the
markup arrived (so a widget taller than the estimate was cropped mid-content), the preview had no measurement to
report, and the settled document replaced it by destroying the preview first — a blank frame, then a jump.

What it does now, and why:

- **The preview measures itself** (`PREVIEW_MEASUREMENT_JS`), so the frame follows the widget's real layout instead of
  the guess.
- **The frame grows and holds while streaming** (`src/web/lib/frame-height.ts`): reports go through the estimate as a
  floor, only ever raise the frame, and are clamped to 80% of the viewport; the ceiling is 4000px. A partial morph
  that collapses does not drag the card with it, and a half-written widget cannot take the screen.
- **The settled document may shrink it again**, undoing the streaming overshoot (a 486px frame settles at 482px).
- **The two sandboxes crossfade**: the preview is kept until the final iframe has reported a height, then both fade
  over 200ms and the preview is dropped. No blank frame, ever.
- **The placeholder suggests a widget**: a shimmering skeleton, the model's own `placeholderMessages` cycling every
  2.6s, and the model's `initialHeight` treated as a placeholder (clamped 96–480) rather than the truth.
- **A re-mounted card keeps its height**: an iframe cannot be re-parented without reloading, and the settled turn is a
  new subtree, so a widget is mounted twice. The second mount starts at the height the widget last reported (cached by
  call id) and never shows the skeleton — the reader sees the same card repaint its content, not resize or blank.
- **The fullscreen control left the widget's corner**: it sits in a reserved strip above the card, so it can no longer
  cover whatever the widget put in its own top-right corner (a dashboard header, a legend, a close button).

Known and accepted: the model's `initialHeight` is still only an estimate, and the second mount still costs one
sandbox boot (~200ms of the widget's own background). Both are noted in SPEC §5.2.

## 10. Beyond the port: the shell stops narrating itself

The session bar was apiary's status pill — a dot, the run in words, the model, the connection, counters, four action
buttons. It reads as a homelab dashboard, and it answers a question the reader only has when something is wrong. The
bar is now a wordmark and one overflow control (`Compact`, `Reset`, diagnostics, and the run/model/tool facts as text
inside the menu). Nothing in it changes while the agent works:

- **A run's state belongs to the run.** The live bubble shows the work and the text as it streams; the bar says
  nothing.
- **Stop belongs where the send button is.** While a run is active the composer shows **Steer**, **Follow-up** and a
  stop square; the bar has no Stop.
- **The model is a diagnostic, not a headline** — it shows in the composer row only while diagnostics are on.
- **A lost connection is announced next to the input it blocks** (a slim pill above the composer, after a 1.2s grace
  so a reload does not flash it), and nowhere else. The reader assumes the agent works; when it does not, they are
  told once, where it matters.

## 11. Beyond the port: the working block is compact by default

The trace auto-expanded while a run was active — every thinking block, every tool row, every line of live output —
which is apiary's shape and the wrong default for a reader who is waiting rather than inspecting. Now the block is
one line that answers "what is it doing": `Working · bash: npm test`, or `Wait…` while a retry backs off, with a
spinner. Nothing under it is open: thinking rows, running tool rows and their live output are all one click away,
and the row summaries still carry the name and the arguments. Diagnostics mode (`?debug=1`) is the mode that opens
everything, which is what it exists for.

Related and unchanged: a settled turn keeps no trace at all unless diagnostics is on, and the live trace folds away
as soon as its bubble produces text or a widget.
