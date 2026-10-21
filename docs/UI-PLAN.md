# UI Plan — Chat Area (sibling look, pi-durable backend)

Status: draft for review. Scope: chat area only. Author: agent, 2026-10-14.

## 0. Summary of decisions

> **Revision (2026-10-20): the client is sent the reader's transcript, not the conversation.** §§2–3 below describe
> the first port, which rendered the raw `ConversationView` (entries, reasoning, tool rows, usage) in the browser and
> hid the machine only by folding traces away. That is gone: `src/server/projection.ts` is the wire boundary and sends
> three cells — `transcript`, `queued`, `agentStatus` — and nothing else (§4.1a in `docs/SPEC.md`). The rendering model
> is now a list of projected items (`user`, `hook`, `delivered`, `widget`, `notice`) plus one working line; the trace
> components, `view-types.ts`, `transcript-model.ts` and the debug mode were deleted with it. The sibling material below
> is kept as the record of how the look was ported, not as the current contract. Denis's reason, and it is the whole
> reason: reasoning, tool calls and tool results are dense model work, and they can carry secrets — they stay on the
> server, where they can be inspected through a trace endpoint later, deliberately.

1. **Take the chat area from sibling** (`DenisSud/sibling` → `packages/web`): turns/bubbles structure, temporary traces, thinking collapsibles, tool rows, streaming tail reveal, append-only DOM behavior, scroll follower + jump pill, composer pill, markdown rules, design tokens — all from `packages/web/src/{turns,transcript,stream,tools,composer,scroll,markdown}.ts` + the chat sections of `style.css`.
2. **One addition to the "traces are not kept" rule:** `generateSandboxedUi` widget cards persist in settled turns. They are the only trace piece that survives settlement; tool rows and thinking still collapse away.
3. **~~Debug mode~~** — removed with the raw view (see the revision above). There is no diagnostics mode; the trace is a server-side concern.
4. **Re-implement as React components** (confirmed) on our existing Chord shell (`src/web/client.ts` subscription stays), porting sibling's pure logic and CSS nearly verbatim. sibling's manual append-only DOM diffing is replaced by stable React keys — same emergent behavior (open `<details>` survive, entries animate once).
5. **Out of scope:** sidebar, bot list, onboarding, panel/drawer, blobatars, setup chip, auth. Minimal session bar stays (status + actions), restyled to sibling's session-bar look.
6. **Decided details:** hook triggers render as a full banner in normal mode; the composer has two send actions while busy (**Steer** / **Follow-up**) and one while idle; no skill chips; widget cards render bare (no caption).

## 1. Backend deltas that matter (sibling was built on the old pi service protocol)

sibling's UI consumed a `TranscriptSnapshot` from the old `pi-client`/`pi-server` era. Our backend is `pi-durable`'s `ConversationView`: `{ conversation, entries, docs }`. The mapping, plus what changed:

| sibling concept (`TranscriptSnapshot`) | ours (`ConversationView`) | delta |
|---|---|---|
| `transcript: Entry[]` with `timestamp` per entry | `entries: EntryRecord[]` — `{ id, kind, model?, data?, head?, byTaskId? }` | **No entry timestamps.** Message-level timing only (`AssistantMessage.timestamp`/`durationMs`, `ToolResultMessage.durationMs`). |
| entry kinds: `message` (user/assistant/toolResult), `compaction`, `branch_summary`, `custom` | kinds: `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, `app.hook` (ours), custom | New: `pi.system` sits between user and assistant in every turn — grouping must not flush turns on it. No `branch_summary`. |
| `operation` (busy state) | `docs["pi.live"].run` | same idea; adds `taskId`, `inputs`. |
| `operation.streamingMessage` | `docs["pi.live"].generation.message` (+ `attempt`) | committed throttled partial; streamed tool-call arguments are in it (genui preview already works off this). |
| `operation.runningTools[]` (`running`/`settled`) | `docs["pi.live"].tools[]` (`pending`/`running`/`done`) + `output`, `droppedBytes/Lines`, `details`, `diagnostics`, `taskId` | **Live output streaming is new** — sibling only saw a result once settled. |
| — | `docs["pi.live"].nestedTools[]` | **New:** sub-calls a running tool made via `executeTool()`, with `parentCallId`, own `arguments`/`output`/`summary` (error, duration, usage). |
| `operation.deferred: boolean` | `generation.deferred: { pollAt }` | "Waiting" state with a timestamp. |
| — | `generation.retry: { at, error }` | **New:** visible retry/backoff (sibling surfaced only generic busy). |
| `queues` (steer/follow-up list) | `docs["pi.inbox"].items[]` `{ id, mode: steer\|followUp\|write, content, entry? }` | **New:** durable ids → per-item withdraw (sibling could only restore text to the composer on abort). |
| `compaction` entry note | `pi.compaction` entry + `live.compactions[]` (`reason`, `blocking`, `attempt`, `retry`) + `live.compactionFailure` | **New live status**; failure banner. |
| — | `docs["pi.usage"]` `{ models, tools }` | **New:** per-model/per-tool spend → debug footer. |
| — | `docs["pi.agent"]`, `docs["pi.provider"]` | **New:** model/extensions/tools/cwd; provider session id → debug inspector. |
| — | `app.hook` entries `{ hookId, hookName, payload, firedAt }` | **New:** proactive turns must render (agent speaks first). |
| tool duration computed from entry timestamps | `ToolResultMessage.durationMs` | Simpler: read the message field. |

Also: entries are a **tree on the server** (`fork()`, `head` markers) but the view shows one active path; `pi.compaction`/`pi.reset` entries can replace spans, so the entries list can shrink between updates. React keys handle this; the transcript must not assume append-only.

## 2. Rendering model (revision: the projected transcript)

### 2.1 What arrives

`TranscriptItem[]`, in order, each item already finished by the server:

| item | from | renders as |
|---|---|---|
| `user` | `pi.user`, with the `[from <name>] ` prefix the server wrote split off it | the reader's bubble, right-aligned; `author` names who wrote it, and is absent for an unnamed device and for every message written before the roster |
| `delivered` | a `send_to_user` call | a message bubble of its own; `streaming` while the call streams, `failed` when its result failed or was interrupted |
| `widget` | a `generateSandboxedUi` call | the sandbox card, bare, at its position; `content` is the mapped `OpenGenUIContent`, never the call |
| `notice` | a run that died | one coarse line: something went wrong, the turn did not finish |

Plus `QueuedItem[]` (the inbox, labelled: the reader's text or `hook: <name>`, with `withdrawable`, and `author` for
whoever queued it), and `AgentStatus` (run status, busy, the **names** of running tools, model, hooks, cwd).

### 2.2 What cannot arrive

Reasoning, tool calls, tool arguments, tool output, `pi.system` sections, usage, entries, `byTaskId`, diagnostics, and
hook triggers (a proactive turn is the message it sent; the schedule stays in the schedule). The
projection is a whitelist: an item exists only because `src/server/projection.ts` names its kind, so a new tool or a new
entry kind is invisible until that file says otherwise. `test/projection.test.ts` pins it from both sides — what the
reader needs arrives, and a secret planted in a tool's arguments and output does not.

### 2.3 The working line

`src/web/lib/working.ts` turns `AgentStatus` into one line under the transcript: `working`, `working: bash`,
`compacting context`, `retrying`; nothing when idle. The line names the latest tool call of the turn and keeps any name
that has not yet had a full `TOOL_LABEL_HOLD_MS` (1 s) on the line until it does, so a tool that returns in
milliseconds is read once instead of flashing; `compacting context` and `retrying` outrank it, and it clears with the
turn. A tool name is the whole of what a reader is told about a running tool — visible work, no exposure of what the
work touches.

### 2.4 What is gone, and why

| removed | why |
|---|---|
| `transcript-model.ts` (blocks → pieces → bubbles) | there is nothing to group: the server sends rows, and a user message, a hook banner and a delivered bubble are separate items |
| `ToolRow.tsx`, `Trace.tsx` | the rows they rendered no longer exist on the wire |
| `DebugBits.tsx`, `?debug=1`, `npm` toggle | it inspected `pi.live` / `pi.inbox` / `pi.agent`, which the client does not receive |
| `view-types.ts` | it described the raw `ConversationView`; the client now types the projected cells from `src/shared/contract.ts` |
| `lib/tool-view.ts` | summaries, durations and icons of tool calls — no tool calls to summarize |

Kept: `markdown.ts`, `stream-text.tsx` (a delivered message still streams as it is written), `follower.ts`,
`frame-content.ts`, `process-partial-html.ts`, `idiomorph-inline.ts`, `websandbox-loader.ts`, `SandboxedUiCard.tsx`,
`WidgetCard.tsx`. `open-genui-content.ts` moved to `src/shared/genui-content.ts`: the server maps a widget call to
content, and both sides spell the shape.

## 3. Files

### Current client shape

| file | role |
|---|---|
| `src/shared/contract.ts` | the three cells and the item shapes both sides spell |
| `src/shared/genui-content.ts` | a widget call's arguments → `OpenGenUIContent` (mapped server-side) |
| `src/server/projection.ts` | the wire boundary: conversation → `transcript`, `queued` |
| `src/web/lib/working.ts` | `AgentStatus` → the one working line |
| `src/web/lib/markdown.ts`, `stream-text.tsx` | ported from sibling, unchanged: a delivered message renders and streams as markdown |
| `src/web/lib/follower.ts` | sibling's scroll pinning, plus a glide on the reader's own send |
| `src/web/components/Transcript.tsx` | maps items to rows, then the queue |
| `src/web/components/MessageRow.tsx` | `UserRow`, `HookRow`, `DeliveredRow`, `NoticeRow` |
| `src/web/components/QueuedRows.tsx` | faded queued bubbles, mode tag, withdraw |
| `src/web/components/{WidgetCard,SandboxedUiCard}.tsx` | the sandbox card, unchanged except its input: content, not call args |
| `src/web/components/{SessionBar,Composer,JumpPill,DictationButton}.tsx` | unchanged in intent; `SessionBar` lost the tool counters and the debug toggle, `Composer` lost the model label |

### Ported from sibling, and what survived

`markdown.ts` and `stream.ts` are still verbatim ports; `scroll.ts` is `follower.ts`. `turns.ts` and `tools.ts` are
gone: their job was to reconstruct bubbles and tool rows from raw entries, and the projection now does the only part of
that a reader needs. `style.css` kept its chat sections minus the trace, tool-row, debug and usage rules.

### Explicitly skipped from sibling

`session.ts`/`auth.ts`/`onboarding*`/`panel.ts`/`bots.ts`/`blob.ts` (no bots/sidebar), `skill-block.ts` (decided: no skill chips; skills are not wired into the durable harness), `branch_summary` (no such entry), `main.ts` (our `main.tsx` shell stays).

## 4. Actions

`AgentService` stays as-is — the same methods (`submit`, `withdrawSubmission`, `abort`, `reset`, `compact`, `fireHook`, `toggleHook`) plus one added optional field, `fireHook.requestId?`: a caller that already holds an event identity passes it and that fire is deduplicated exactly, while a control pressed in the transcript passes none and is a gesture of its own.

- Composer: idle → one send button → `submit({ content })`. Busy → two send buttons, matching the backend's queue modes exactly (`applyBoundary` in durable: steers at the `postTools` boundary, follow-ups only at `final`):
  - **Steer** → `submit({ content, whenBusy: "steer" })` — placed when the current tool round ends (before the next model step); if the generation produces no tools, it lands at run end.
  - **Follow-up** → `submit({ content, whenBusy: "followUp" })` — placed only when the run ends (the model has finished all its turns).
  Busy placeholder "Steer or follow-up…". Queued bubbles label the mode (`steering` / `follow-up`).
- Stop: `abort()`; queued items stay visible (durable inbox) instead of sibling's restore-to-composer.
- Compact: `compact()` while idle.
- ~~Debug sheet~~ — removed with the raw view. Firing a hook by hand is a server-side or webhook action now; a UI for it
  belongs to the trace endpoint that replaces the inspector.
- Widget bridge unchanged: `sendPrompt` → `submit({ whenBusy: "followUp" })`, `openLink` → new tab.

## 5. Phases

Phases 1–5 were run against the raw-view port. The revision replaced phase 1 with the projection (`projection.ts` +
`test/projection.test.ts`) and deleted the debug phase; the look, the composer, the follower and the widget card carry
over unchanged.

## 6. Verification (agent-browser)

1. Desktop: send a message with the faux model scripted to run `bash`, `generateSandboxedUi`, then text — assert: working trace → collapse; widget persists; markdown tail reveal.
2. Settled turn shows text + widget, no tool rows (normal), all rows (debug, toggled live).
3. Fire `workspace-check` with faux responses — hook banner visible, proactive answer streams.
4. Busy: send a second message → queued bubble with tag; withdraw → gone.
5. Mobile 390px: composer grows/caps; jump pill appears when scrolled up; touch targets ≥ 44px.
6. Dark mode + `prefers-reduced-motion`.
7. Kill/restart server mid-run → reconnect banner → resumed run streams into the same transcript (durable bonus).

## 7. Decisions log (all resolved)

Resolved (2026-10-20) — the wire boundary:

10. **The client is sent the reader's transcript, not the conversation.** Denis: reasoning, tool calls and tool
    results are dense model work and can carry secrets, so they stay on the server; the client receives user messages,
    delivered messages, widgets, triggers, coarse notices, the labelled queue and a status whose tool list is names
    only. A trace endpoint can expose the rest later, deliberately.
11. **The transcript is a whitelist, not a filter.** `src/server/projection.ts` names every item kind it forwards. A
    new tool or entry kind is invisible until it is named there, so nothing leaks by accident — and the same file is
    the one place a reviewer has to read.
12. **Widgets stay, as artifacts.** A `generateSandboxedUi` card is output built for the reader, not the machine's
    working notes, so it crosses as mapped content (`OpenGenUIContent`), never as the call that built it. Deleting the
    feature would have been a bigger decision than this one.
13. **A failed run is one coarse notice.** "Something went wrong, and the turn did not finish" — the provider's error
    text stays on the server. The Retry control went with it: retrying is the supervisor's job and a server action, not
    a button over a message the reader can no longer diagnose.
14. **No debug mode.** `?debug=1`, the diagnostics sheet and the usage panel inspected state the client no longer
    receives; keeping the flag would have meant keeping the raw view on the wire for the sake of a toggle.
15. **The reader's own send glides; nothing else does.** Following a stream writes `scrollTop` instantly, because
    animating toward a target that keeps moving lags and wobbles. A send is the opposite case: the target is a row
    that has not arrived yet and the reader is entitled to watch it land, so `glide()` re-pins, animates, and keeps
    animating for the few hundred milliseconds the row and its echo take — then the next stream is instant again.

Resolved (2026-10-14):

1. React re-implementation (not vendoring sibling's vanilla modules).
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

15. **A trigger shows no banner.** "triggered Morning brief" told the reader about the scheduler, not the conversation:
    a hook's name, payload and fire time are machine-side detail, so no row is sent for one. Titles live in the hook
    definition, which is where the reader goes to change it. Any future "this is proactive" signal has to earn its place
    in the transcript; the delivered message does not need it.

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
- **Leaving fullscreen restores the card *and* its document.** The overlay gave the document the viewport's height, so a
  widget that stamps a child at its measured size (an SVG chart, a canvas) props up the very flex box that measures it
  and can never shrink itself: after Exit the card came back at its old height around a document still laid out at
  1050px, clipped. A measurement taken while leaving is refused (`isFullscreenEcho`), because it describes the overlay;
  the height the card is returning to is handed to `embeddedFrameJs(restore)`, which pins `html, body` to it for one
  layout pass so `height: 100%` and flex children re-derive, and releases on the second animation frame — after the
  widget's own ResizeObserver re-stamps at the card's size. Taller reports are refused only for the length of that pass
  (`isRestoreEcho`), so a widget that genuinely needs more room grows a frame later, and a widget that never entered
  fullscreen runs exactly the embedded path it always ran. No remount, so state inside the widget survives.

Known and accepted: the model's `initialHeight` is still only an estimate, and the second mount still costs one
sandbox boot (~200ms of the widget's own background). Both are noted in SPEC §5.2.

## 10. Beyond the port: the shell stops narrating itself

The session bar was sibling's status pill — a dot, the run in words, the model, the connection, counters, four action
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
which is sibling's shape and the wrong default for a reader who is waiting rather than inspecting. Now the block is
one line that answers "what is it doing": `Working · bash: npm test`, or `Wait…` while a retry backs off, with a
spinner. Nothing under it is open: thinking rows, running tool rows and their live output are all one click away,
and the row summaries still carry the name and the arguments. Diagnostics mode (`?debug=1`) is the mode that opens
everything, which is what it exists for.

Related and unchanged: a settled turn keeps no trace at all unless diagnostics is on, and the live trace folds away
as soon as its bubble produces text or a widget.

## 12. Beyond the port: a name on every message

The transcript was built for one person: every bubble was "the reader", and who said what was context the model had to
guess at. A team shares the one conversation (`docs/TEAM-IDENTITY.md`), so the reader's own messages carry the name the
server wrote into them, and the reader sees whose words a bubble holds before reading it:

- **The picker is a name claimed off a roster, not an account.** `/join` asks a paired browser which of the roster's
  names is its own, and `POST /api/join` seals the answer into the session cookie server-side: the page never sends the
  name with a message and cannot set the cookie, so the author on a row is a claim the server made. An empty roster says
  so and names the command that fills it, and a browser whose cookie was lost claims again from the same screen — the
  pairing is not what is being asked about.
- **The author chip says whose bubble it is.** A user row and a queued row carry `author` when the server found one, and
  `AuthorChip` renders it above the text: the reader's own name stays quiet, because it is a stamp on their own sentence
  rather than information, and everyone else's is the one mark that separates two speakers in a shared column. A row with
  no author — an unnamed device, or anything written before the roster — simply has none.
