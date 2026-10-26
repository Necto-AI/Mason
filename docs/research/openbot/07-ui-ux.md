# UI/UX — screens, flows, design system

## What it is

A React 19 / TanStack Router / Tailwind 4 / Base UI single-page app (`app/`, ~112k LOC) for a
multi-bot workspace: a conversation roster, a chat surface with composer, a per-bot profile,
capability and connection screens, and a twelve-entry admin rail. Server state is TanStack Query plus one
socket; chat is CopilotKit 1.77 (`app/package.json`). No token layer of its own: shadcn CSS variables in oklch over a vendored `components/ui` tree.

## How it works

### Shells and gates

```
_authed      session gate + onboarding redirect; mounts CopilotProvider + hotkeys  (routes/_authed.tsx:7,26)
├── onboarding   no chrome at all                                                  (routes/_authed/onboarding.tsx:318)
├── _app         SidebarShell 340px, h-svh overflow-hidden, panes scroll inside    (routes/_authed/_app.tsx:14)
├── settings     SidebarShell 300px, own nav rail                                  (components/settings/settings-sidebar.tsx:23)
└── admin        role !== "admin" redirects home                                   (routes/_authed/admin/route.tsx:12)
```

`PageShell` (`components/layout/page-shell.tsx:40`) frames every configuration
screen at a 720px prose column, with `wide` (max-w-5xl) reserved for the audit table and explicitly
"not a licence for anything else" (`:36-37`). It exists because Admin had been nine pages with four
container widths, four heading sizes and three pages that imported nothing from `components/ui`
(`:8-20`).

### Screen by screen

**Onboarding** — three slides plus three shown only when the server says `localEvaluation`
(`onboarding.tsx:267,302`). Artwork is real components inside `IllustrationFrame`, which is
`pointer-events-none` **and** `inert`, with an outer `role="img"` and a label
(`components/onboarding/illustration-frame.tsx:29,32`).

**Bots** — `/bots` groups the roster into "Needs you", "Pinned", "Yours", "Shared with you"
(`components/bots/bot-roster.tsx:66`), where "needs you" is questions + approvals + stalled hand-offs
(`components/bot-profile/attention.tsx:11`). That number also drives a sidebar badge and an opt-in
browser notification (`:32,75`). Creation is a right-hand sheet with a `sr-only` title
(`new-bot-sheet.tsx:79`); its first question is where the bot runs, which decides what the rest
means (`:86-97`).

**Conversation** — `/channel/$channelId`. A sticky header carries avatar, name, computer and settings toggles; the latter two share a detail
pane whose open state is a URL search param (`routes/_authed/_app/channel/$channelId.tsx:34,69,82`). Transitional states are typed:
`RestoringTranscript` draws shaped placeholders (`chat-transcript.tsx:153`), `Thinking` shimmers in the
answer's slot (`:183`), `Stopped` renders the reason the turn ended as a sentence, never as a message
(`:209`). The composer holds `@`-mention and `/`-skill triggers (`composer/triggers.ts:54,77`),
attachments with a refusal strip above the box, dictation, and a send/queue/stop button whose
accessible name changes with what it will do (`composer.tsx:1337,1346`).

**Approvals** — one owner-scoped inbox, three surfaces: inline where the tool call would have been
with Allow once / Always allow here / Deny (`components/approvals/inline-approval.tsx:44-46`); as rows
on the bot profile (`components/approvals/waiting.tsx:30`); as policy in Settings
(`components/approvals/settings.tsx:90`). A `hand_off` policy swaps the buttons for "I did it myself"
/ "Don't do it" (`inline-approval.tsx:36-41`).

**Routines** — rows with a switch, a last-run chip whose four outcomes are toned and whose neutral
cases are deliberately not errors (`components/routines/routines-list.tsx:69-110`), plus Run now,
History, Delete.

**Memory and capabilities** — `/capabilities/{skills,memory}` is one page with tabs drawn as links so
each keeps an address (`components/capabilities/capabilities-shell.tsx:23,53`). Memory is a fact list
whose one primary verb is a header button ("Remember a fact"), not a form above the list
(`components/memory/memories.tsx:43,147`).

**Connections** — "the services a Bot reads as you": a searchable row list with per-service pages
(`routes/_authed/_app/connections.index.tsx:364`). OAuth callbacks report through search params read
as text whatever the router parsed them into, because a numeric vendor key would otherwise vanish
(`:60-72`).

**Channels** — openbot also uses the word for a delivery destination on Reachability: Slack, Teams,
SMS, chat link, each a connected row with Disconnect (`components/delivery/reaching-you.tsx:185,237`).

**Computer** — a live browser in a 400px pane, optionally opened by URL (`channel/$channelId.tsx:82`),
with an Activity log beside it (`components/computer/computer-panel.tsx:5`). Ownership is explicit:
one button reading "Take control" or "Hand back" (`components/computer/computer-controls.tsx:29`),
`aria-expanded` on the toggle, a labelled dot when the computer wants the person (`:79,90`), and
auto-open once per new prompt where closing counts as dismissal (`:60-77`).

**Settings** — dark theme, message-list emphasis (bot name vs channel title, as a user preference),
standing instructions, and a shortcut list generated from the binding registry so it cannot drift
(`routes/_authed/settings/index.tsx:35,66,72`). Rail: General, Notifications, Approvals, Passwords,
Components gallery (`components/settings/settings-sidebar.tsx:23-60`).

**Admin** — twelve entries in four groups named by the decision, not the code: "What Bots can reach /
can do / Who can get in / What happened" (`components/admin/admin-sidebar.tsx:39`, mirrored exactly at
`routes/_authed/admin/index.tsx:29`). Gallery pages preview components from stored props, so a tile
answers "what does an answer look like" (`lib/copilot/gallery-registry.ts:33`).

### Design system

One stylesheet (`app/src/styles.css`, 291 lines): two oklch palettes behind `.dark` (`:21,58`),
exposed through `@theme inline` (`:122`). One typeface, Inter Variable
(`:6,124`); root is **15px, not 16** (`:18`), which the prose column is dimensioned against
(`page-shell.tsx:26`). No spacing or type-scale module exists. `components/ui` is vendored
shadcn/Base UI with two local divergences: `Button` derives `nativeButton` from whether `render` was
passed, so router links get `role="button"` and Space activation instead of a meaningless
`type="button"` (`components/ui/button.tsx:49-64`); `MessageScroller` only takes a tab stop when it can
scroll (`components/ui/message-scroller.tsx:46`). Config screens use four primitives: `PageSection`,
`PageRows` (a divided card), `PageEmpty` (a sentence, not an illustration), `Item`
(`page-shell.tsx:149,187,218`).

### Interaction patterns

- **Streaming.** Messages memoise on primitives, because a streamed answer rebuilds the array every
  chunk and an object memo misses every time (`chat-transcript.tsx:614-624`). Entrance animation runs on
  mount only, transform and opacity only (`:468-490`).
- **Turn vs run.** `pending` is the turn (drives the queue drain); `stoppable` is the run (drives Stop)
  (`channel-chat.tsx:1058,1072`).
- **Queueing.** Typing while busy parks the message; the queue runs as one follow-up turn; a failed
  drain restores messages and their staged attachments. It says plainly that it is not an outbox
  (`components/channels/composer/queue.ts:23-33`).
- **Tool calls.** One `ToolLine` for every tool: label, muted detail, three tones (muted, amber
  "didn't work", destructive "Blocked:"), expansion owned by native `<details>`
  (`components/channels/tool-line.tsx:13,36,63`). Adjacent plain calls fold into one row
  (`tool-activity.tsx:46-84`); anything that asks the person a question never folds (`:95`). A render
  throw is contained to the card (`tool-boundary.tsx:30`).
- **Optimistic UI** is narrow: dismissals and read markers patch in `onMutate` and roll back
  (`lib/settings/message-list.ts:41`); pinning is "a marker, not a reorder, so no optimistic sort"
  (`lib/channels/mutations.ts:80`).
- **Empty vs error.** A load failure may only be claimed when the query never once succeeded; search-
  empty quotes the query back (`routes/_authed/_app/index.tsx:110-125`,
  `components/app-sidebar/app-sidebar.tsx:295-313`).
- **Motion.** `useReducedMotion` in 33 components; reduced motion keeps fades, drops movement, and
  removes the tool-line shimmer (`styles.css:226-236`).

### Accessibility, as the code shows it

132 `aria-label`, 260 `role=`, 20 `sr-only`, 10 `aria-live`/`aria-busy` sites in `app/src`. Naming is
per widget, not systematic: badges carry `role="img"` plus a label (`attention.tsx:88,96`), progress is
`role="status"` and errors `role="alert"`, with the reason recorded at the call site
(`composer.tsx:1458`, `chat-transcript.tsx:189`, `rejected-files.tsx:70`). One global hotkey, Shift+N,
chosen because browsers reserve Cmd/Ctrl+N (`lib/hotkeys/hotkeys.ts:8-13`), layout-aware key resolution
and exact-modifier matching (`:64,78`). The computer view forwards keystrokes to the remote page but
yields to local fields (`components/computer/live-screen.tsx:76`). Absent: no skip link, no axe
dependency, no a11y test among the 215 files in `app/tests`.

## Decisions and their reasons

- **Uniform shell over per-page layout.** Bought one visual system across Admin, Settings and Skills;
  cost is a 720px prose column under everything, with a hard-coded exception for the audit table.
- **URL as the state channel for panels and sheets.** Back closes them, links work, reloads survive
  (`components/layout/detail-panel.tsx:11`, `routes/_authed/_app/bots.index.tsx:12`). Cost:
  `validateSearch` plumbing everywhere plus text-coercion of callback params.
- **Native affordances over reimplementation.** `<details>` for tool expansion, `Notification` for
  interruptions, Base UI for dialogs. Bought keyboard and screen-reader behaviour; cost is styling
  fights.
- **Copy is the error UI.** No toast stack; failures are sentences in place, with a documented rule
  about which sentence is allowed (`routes/_authed/_app/index.tsx:110`).
- **Docs vs code.** README and `docs/architecture.md` do not mention the shells, the design system or
  accessibility. Everything above is code-only knowledge and decays with it.

## Mason-relevant

**Worth copying**

1. **Turn/run split in the composer.** Mason already has durable Steer and Follow-up modes
   (`docs/UI-PLAN.md §4`); openbot's `pending`/`stoppable` naming (`channel-chat.tsx:1058,1072`) is the
   clearer contract — queue drains on the turn, Stop draws from the run. Port the distinction as props.
2. **Tool rows as one line, three tones, native disclosure** (`tool-line.tsx:13-40`). Mason's projection
   sends no tool detail; the *shape* — what it did, to what, blocked vs failed — is worth keeping while
   arguments stay server-side.
3. **A stopped turn as a sentence in the answer's slot, never a message**
   (`chat-transcript.tsx:209`). Same idea as mason's `notice`; openbot's reason (the bot would read its
   own obituary on the next turn) is the part to write down.
4. **`IllustrationFrame`: `inert` + `role="img"` + label** (`illustration-frame.tsx:29,32`). Any
   decorative UI masquerading as controls needs all three, not just `pointer-events-none`.
5. **One inbox, several surfaces.** Approvals, questions and hand-offs read one owner-scoped query, so a
   decision made inline equals one made on the profile (`inline-approval.tsx:11-22`). That is the shape
   a mason permission prompt should have.

**Worth avoiding**

1. **Five navigation models and one overloaded word.** Roster, bot sub-pages, capability tabs, settings
   rail, admin rail — and "channel" meaning both a conversation and an SMS/Slack destination
   (`delivery/reaching-you.tsx:185`). Mason has one bot and one room; importing this imports ambiguity.
2. **A 1,700-line composer.** Queue, attachments, dictation, triggers, paste capture, drop negotiation
   and voice in one tree; well reasoned, still unsafe to change. Keep the queue outside the input.
3. **Inline hex-adjacent tone literals instead of semantic tokens.** `text-amber-600
   dark:text-amber-500` is written out in `tool-line.tsx:39` and `routines-list.tsx:92,154` while a
   `--success` token exists and is barely used.

**Already right in mason**

- Mason's projection whitelist (`docs/UI-PLAN.md §2.2`) is stricter than openbot, which streams tool
  arguments and results to the browser and then defends the transcript with a folding heuristic
  (`tool-activity.tsx:46`). Keep the whitelist.
- Mason's queue is a durable inbox with withdrawable ids (`docs/UI-PLAN.md §4`); openbot's is memory in
  one mount and admits it (`queue.ts:23`). Keep the durable one.
- Mason's plan already commits to 44px targets, dark mode and reduced-motion verification (§6.5-6);
  openbot's compact controls are 28-32px (`composer.tsx:1341`), a desktop-only assumption.

## Open questions

- Whether the 15px root and 720px column were measured or merely chosen: no test, no doc, only the
  assertion (`styles.css:18`).
- Whether any accessibility audit has run. Per-widget ARIA is dense and deliberate, but with no axe
  pass and no skip link, density is not coverage.
- What `mobile/` and `desktop/` reuse from `app/`; if they re-implement screens, the system's real
  surface is larger than `app/src`.
