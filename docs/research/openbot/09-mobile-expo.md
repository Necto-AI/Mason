# Mobile app (Expo)

## What it is

`mobile/` is a 2,440-line Expo/React Native shell around the same HTTP API the web app uses: ten screens, one
stack, its own npm package, no shared code with `app/`. The desktop app is a webview of the web build
(`desktop/src-tauri/tauri.conf.json:7` loads `../dist`); this is a second client, and its reason to exist is what
the web app cannot do: arrive as a notification, and answer an approval without a laptop.

## How it works

```
index (sign in, conversations, enable push)
├── approvals   pending requests + questions, decisions, free-text answers
├── bots ── bot pause/resume, routines, Customize: plugins | memory | rules
│            ├── routine  active, schedule, next run, Run now, run history, delete
│            ├── computer live frames, control, click/type/key/scroll, secret entry
│            └── plugins | memory | rules
└── conversation  history, agent switcher, composer
```

Routes are files under `mobile/app/`, one `Stack` with plain titles (`mobile/app/_layout.tsx:37-50`): no tabs, no
drawer, everything pushed. Each screen repeats its own gate, `if (!session && !isPending) return <Redirect
href="/" />` (`mobile/app/bots.tsx:14`, `mobile/app/approvals.tsx:22`), reading `authClient.useSession()` directly;
there is no auth provider.

**Auth and session storage.** `createAuthClient` with the Better Auth Expo plugin keeps the session in the OS
keychain via `SecureStore`, keyed by host (`mobile/src/auth.ts:21-31`). Sign-in is Google/Microsoft/Okta social or
enterprise SSO returning to `openbotmobile://` (`mobile/src/auth.ts:33-50`); the server mounts the Expo plugin and
trusts that scheme only when `EXPO_PROJECT_ID` is set, because any Android app can register it
(`server/src/auth/index.ts:206-219`, `:322-325`; `server/tests/auth-mobile-scheme.integration.test.ts:6-10`). The
base URL must be HTTPS and a bare origin (`mobile/src/auth.ts:10-19`).

The transport is unusual: the Expo client keeps the session as a cookie string, so `api()` reads it out of the
keystore and sets a `Cookie` header itself (`mobile/src/api.ts:6-17`).

**Refresh model.** `useLoad` fetches on mount, then every 10 s while `AppState` is `active`, plus pull-to-refresh
(`mobile/src/use-load.ts:24-32`, `mobile/src/ui.tsx:38-68`).

**Push, and what it wakes.** Push is opt-in from the home screen (`mobile/app/index.tsx:148-160`). `registerPush`
requires a physical device and an EAS project id, creates the Android channel, asks permission, gets an Expo token,
mints a device UUID in the keystore, then POSTs `/api/delivery/devices` (`mobile/src/notifications.ts:10-45`). The
server refuses a device whose project id is not the deployment's (`server/src/delivery/routes.ts:199-221`).
Sign-out deletes the device then signs out (`mobile/app/index.tsx:198-206`).

Push is not a separate notification system: it is one delivery transport beside Slack/Teams and SMS. `notify()`
offers the same message to every chat binding the person has and, if routing allows push, to every device they
registered, deduped per device (`server/src/delivery/router.ts:163-181`). Three kinds leave — `reply`, `question`,
`approval` — carrying a deep link to the conversation or to an approval (`server/src/delivery/push.ts:44-58`). The
title is always `OpenBot` (`server/src/delivery/router.ts:479`), the body is 200 characters of message text
(`server/src/delivery/push.ts:51`), and the handler shows a banner and a sound but sets no badge
(`mobile/app/_layout.tsx:7-13`).

What a tap wakes is a screen and nothing else: no background fetch, no silent push, no action buttons, no
reply-from-notification. `notificationDestination` parses the link before routing — scheme, no user/password/
port/hash, two hostnames only, `channelId` required and length-capped (`mobile/src/links.ts:1-37`), with hostile
URLs enumerated in `server/tests/mobile-links.test.ts:20-23`.

**Approvals.** The inbox filters to pending requests, prints `botId`, `toolRef`, effect and scope, dumps the
argument preview as raw JSON, and offers Allow once / Always allow / Deny; questions get a free-text answer
(`mobile/app/approvals.tsx:84-160`). There is no approval UI inside `conversation.tsx`: a Bot that asks while you
are chatting on the phone gets no answer there, only in the inbox.

**Routines.** A Bot's routines are the global list filtered by `agentId` (`mobile/app/bot.tsx:54-56`); the detail
screen toggles enabled, runs now, deletes with a confirm, and lists runs with colour-coded status
(`mobile/app/routine.tsx:41-140`). Creation is deliberately not a form: "Add routine" finds an active conversation
with that Bot and opens chat with `"Set up a routine to "` in the composer (`mobile/app/bot.tsx:78-100`,
`mobile/src/routines.ts:20`), and the schedule stays display text the client never parses (`mobile/src/api.ts:76-78`).

**Computer.** Opening the screen takes control once per visit (`mobile/app/computer.tsx:142-174`), streams JPEG
frames over the authenticated `/stream` socket with a 1.5 s screenshot poll as fallback (`:25-123`), maps a tap to
a scaled click (`:263`), sends type/key/scroll, offers a masked field for a secret and clears it after sending
(`:243-250`), releases control on unmount (`:184-191`), and polls control state every 2 s (`:177`).

**What it deliberately does not do.** No new conversation, no new Bot, no tool connection, no schedule editing, no
admin, audit, passwords, connections, reachability or responsibilities. The screens say so: "No conversations yet.
Create one in OpenBot on your computer." (`mobile/app/index.tsx:193`), "Connecting an app needs its sign-in, so add
and remove tools in OpenBot on your computer." (`mobile/app/plugins.tsx:91-93`).

## Decisions and their reasons

**A second client, not a shell.** The repo already had the cheaper pattern, a desktop webview of the web build,
and mobile chose a native rewrite of ten screens. The consequence is a constraint in CI rather than an argument:
mobile is an isolated npm package, outside the Bun workspaces, because adding it "would change the existing
desktop/server installation contract" (`.github/workflows/ci.yml:110-112`, `package.json:6-12`). It imports
nothing from `shared/` or `app/` and restates a dozen wire types and one label map by hand
(`mobile/src/api.ts:33-156`, `:116-121`), checked by typecheck alone (`.github/workflows/ci.yml:100-116`); there
is no test runner, no `expo-updates`, and no `submit` profile (`mobile/eas.json:1-7`), so every JS fix needs a
store build.

**Push was the forcing function.** The web app ships no manifest and no service worker (`app/index.html:1-19`), so
there was no web-push path to extend: a notification on a phone required an app. Everything else the app does —
approvals, routines, memory, rules, plugins, computer control — is reachable in the web client already, and was
carried over so the notification's destination would not be a "please open your laptop" page.

**Documentation says how little it is a product.** `README.md` never mentions mobile and `CHANGELOG.md` never
announces it; the only prose is the environment table (`docs/configuration.md:559-567`) and a CI row
(`docs/releasing.md:123`). Meanwhile the web client was separately made phone-usable (`CHANGELOG.md:3212`,
`:3334-3345`), so the repo holds two answers to "reach me on my phone" with no stated rule for which one wins.

## Mason-relevant

**Worth copying:**
- **Device identity that can be revoked, and is.** A device row is per person, created on opt-in, deleted on
  sign-out, and removed again when Expo's receipt says `DeviceNotRegistered`
  (`server/src/delivery/routes.ts:199-222`, `mobile/app/index.tsx:198-206`, `server/src/delivery/router.ts:419-441`,
  `server/src/delivery/push.ts:103-105`). That is the whole lifecycle for any push face mason adds.
- **A client-minted id per send.** The composer sends `externalId = randomUUID()` with each message so a retry is
  the same message (`mobile/app/conversation.tsx:63-70`, `server/src/delivery/routes.ts:246-256`); mason's
  steer/follow-up submit has the same at-least-once problem.
- **An allowlist before routing a tapped link** (`mobile/src/links.ts:1-37`), with the hostile cases as tests.
- **Scheduling as a chat turn, not a client form** (`mobile/app/bot.tsx:78-100`): the phone never learns the
  schedule grammar, so it stays server-owned. **Take on open, release on unmount** for a shared resource
  (`mobile/app/computer.tsx:184-191`).

**Worth avoiding:**
- **A second client with no shared wire types.** mason's transcript is a whitelist (`docs/SPEC.md` §4.1a) and its
  rendering is the hard part of `docs/UI-PLAN.md`; openbot's phone re-derives a *shallower* view of the same
  history — tool activity becomes "The Bot is using a tool." (`mobile/app/conversation.tsx:128-132`) — with
  typecheck the only thing comparing the two.
- **Polling a chat every 10 s** (`mobile/src/use-load.ts:29-31`) where the browser has a socket. A phone is where
  that trade costs battery, and mason's Chord socket is already one connection to one origin.
- **Cookie re-injection instead of a bearer credential.** `api()` and the socket both hand a stored cookie to a
  native stack (`mobile/src/api.ts:7-17`, `mobile/app/computer.tsx:35-45`); mason already specifies a native client
  presenting `Authorization: Bearer` from the keystore (`docs/SPEC.md:505-537`), the smaller surface.
- **A notification that names nobody.** Title `OpenBot`, 200 characters of text, no Bot name, no badge
  (`server/src/delivery/router.ts:479`, `server/src/delivery/push.ts:51`, `mobile/app/_layout.tsx:12`); with several
  Bots the lock screen is ambiguous.
- **An approval you cannot answer where it was raised.** `conversation.tsx` has no approval affordance; the inbox
  is a separate push target.

**Already right in mason:**
- **Mobile-ready web instead of a native app** (`docs/SPEC.md:8-9`, `:51`, `docs/UI-PLAN.md:149`). openbot needed
  the shell because its ambient channel was push; mason's is an integration that already lives on a phone
  (`integrations/telegram/README.md`), with its own lock screen and its own answers.
- **A device as a revocable pairing token** (mason's `device`, `docs/SPEC.md` §4.1b) is openbot's device row without
  a second client to keep in step.
- **One projection for every reader**, so a second client would render what the whitelist names instead of a
  thinner transcript.

**Does a native shell buy what a PWA plus push does not?** In openbot's hands it bought four things: push that
arrives on iOS without add-to-home-screen; an OS entry point into one approval; a keystore-held session that
survives restarts; a full-screen surface for driving the Bot's computer. It bought no device capability at all —
the app touches notifications, secure storage and the screen and nothing else (`expo-network`, `expo-web-browser`,
`expo-linking` are declared but imported nowhere, `mobile/package.json:13-33`). Three of the four are reachable
from an installed web app; the one that is not is the iOS install prerequisite for Web Push. That is a real
difference, and the only one. The price is a second client with its own auth, types, release train and
typecheck-only coverage. For mason — no approval prompt to answer, ambient reach already a chat integration — the
price is not worth paying now, and the honest gap is smaller than "no app": the web client is not installable and
has no push, so the first step is a manifest, a service worker and a Web Push subscription over the transcript the
browser already renders.

## Open questions

- **When and why the native app was added.** The clone is shallow (one commit), and neither `README.md` nor
  `CHANGELOG.md` mentions it; the introducing commit upstream would settle intent.
- **How it ships.** `eas.json` has no `submit` profile and production sets nothing (`mobile/eas.json:1-7`); public
  stores or internal builds is not determinable.
- **Whether the dual path is intentional.** Nothing states when a phone should use the native app and when the web
  page, while `CHANGELOG.md:3212` and `:3334` improve the web for phones in the same tree.
- **Whether mason wants installability at all.** No manifest, service worker or Web Push appears in `docs/`;
  `src/web/index.html:5` stops at `viewport-fit=cover`.
