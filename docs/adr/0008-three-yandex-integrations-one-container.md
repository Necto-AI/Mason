# Three Yandex integrations, one container

**Status:** Proposed

**Date:** 2026-10-27

**Revisited if:** a Yandex surface stops being one vendor's service — Calendar moving off Yandex's CalDAV would end
the shared credential store and split the image; if the agent needs to react to mail within minutes rather than at a
routine's hour, which is the trigger face this declines; or if the operator would rather have one switch over all
three than three switches over one vendor.

The operator asked for his mail, his calendar and his Disk behind one bot, and for a clean integration rather than
three shims. `docs/research/yandex-integrations/` (107 sources, mostly primary) settles what each surface costs: Disk
is one OAuth token and a dozen REST endpoints, Calendar is CalDAV behind an app password, Mail is IMAP with an error
taxonomy. Three protocols, three grants, one vendor, one operator.

An integration is a service with at most two network faces — an MCP endpoint that lends tools, and one authenticated
POST that wakes the bot (`docs/adr/0003-integrations-are-services.md`) — and an entry in `integrations.json` is the
unit of a prompt line, a tool namespace, a switch and an optional trigger. Both directions are wrong here:

- **Three containers**, one per service, is what the notes assume. It means three images, three `/data` volumes, three
auth bootstraps, three chances to lose the dynamic `*.disk.yandex.net` proxy rule, and a few thousand lines of one
program patched as three.
- **One entry** gives one trigger, one namespace and one prompt line to three different jobs: `list` would mean files in
one call and mail in another, and "a file appeared on Disk" is a different sentence to wake on than "mail arrived".

## Decision

**One image, three entries.** `integrations/yandex/` is one TypeScript program, one Dockerfile, one `/data` volume and one
credential store, serving three MCP endpoints on `:8082` — `/mcp/disk`, `/mcp/calendar`, `/mcp/mail`, one
`deploy/compose.yandex.yaml` turned on with `COMPOSE_EXTRA_FILES`, no published port. mason gets three entries
(`yandex-disk`, `yandex-calendar`, `yandex-mail`), each with its own description, its own switch and — when it earns
one — its own trigger and hook. Inside a namespace there is no vendor prefix: `yandex-disk` offers `list`, `stat`,
`recent`, and the model reads `mcp__yandex_disk__list` (hyphens sanitize to underscores, `src/server/mcp.ts`). A
fourth Yandex surface is a fourth endpoint and a fourth entry, not a fourth image.

**No trigger face in v1, on any of the three.** The proactive layer is a routine, once
[#75](https://github.com/DenisSud/mason/pull/75) lands — open as this is written — and an 08:00 routine calls
`mcp__yandex_calendar__events` and `mcp__yandex_mail__unread` and decides what today looks like. A per-change calendar
event is noise, and the Calendar note reaches that conclusion on its own. Nothing polls, so nothing keeps a
`seen.json`, a `sync-token` or a `UIDVALIDITY`, and no trigger secret is minted for a face that has never fired. Mail
`IDLE` is the one face worth adding later, and it is a trigger on `yandex-mail` alone when it comes.

**Three credentials and one bootstrap.** Disk takes an OAuth app of type "for API access or debugging" with
`cloud_api:disk.read`, `.write` and `.info`. Mail takes an app password. Calendar takes an app password of the CalDAV
type. Mail keeps the app password rather than riding the same OAuth app because drafts need `APPEND`, `mail:imap_ro`
permits no write at all, and `mail:imap_full` is documented as read-and-delete with no word on `APPEND` — so an OAuth
mail grant would either ship without drafts or hold a delete permission the agent does not need. The notes make that
their first of three decisions, for exactly this case: an app password for a single owner's own mailbox. A Mail app
password can also send, and that authority stops at the image: it has no SMTP client, so no configuration turns
sending back on.

**The grant is a link, a sign-in, a code, one command.** An app of type "for API access" has its `redirect_uri` pinned to
`https://oauth.yandex.ru/verification_code` and cannot be changed: there is no callback URL to register and no
listener to run. So `response_type=code` → the operator signs in → Yandex's own page prints a code → the code goes
into one command in the container, which exchanges it and writes the grant to `/data` 0600. The command prints the
link; delivering it into a chat as a single-use link behind the owner session is a mason-side mechanism that does not
exist yet, so v1 leaves that paste and that link in the operator's terminal. Whether an API-access app may use
`/device/code` instead — the one unverified fact in the research — is the build's first probe; if it may, the paste
disappears, and the design does not depend on the answer either way.

**The tool surface is the fence, because the credentials are not.** A CalDAV app password reads and writes every calendar
the account can see, and an IMAP grant reaches the whole mailbox. So the boundaries live in what the container
exposes. Calendar is read-only in v1 — lists, events, one event, todos, free slots — and `YANDEX_CALENDAR_MODE=write`
is a later switch that adds create, update and a task and still never delete, an attendee or raw iCalendar. Mail reads,
searches and drafts, and the image contains no SMTP client at all. Disk writes anywhere under `YANDEX_ROOT` while
publish and permanent delete stay off by default. This is the same argument the Calendar note makes, and the one
ADR-0003 makes about the trigger: the fence is code we own.

## Consequences

- **The Disk root is `disk:/`, so the agent works on the operator's real Disk.** This reverses the Disk note's §7, which
argues for `cloud_api:disk.app_folder` first so the token physically cannot reach the owner's files. The operator
asked for read and write everywhere, and a sandbox in an applications folder is not that.
`YANDEX_ROOT` narrows it without a rebuild.
- **`integrations/yandex/` supersedes the per-service package names in the notes** (`integrations/yandex-disk/` and its
siblings). The notes describe the containment, not the repository layout.
- **Nothing wakes the agent, so "a file appeared" is not an event.** It is something a routine looks for, or something the
operator mentions. That is the accepted cost of shipping without pollers.
- **A Mail app password activates in 2–3 hours**, and a credentials failure inside that window means nothing. The first
boot after the grant says "not yet active" rather than "authentication failed".
- **Both kinds of grant die silently.** Changing the account password, toggling 2FA, recovering the account, logging out
everywhere, editing the app's scopes or deleting it each revoke every token; the page that issues app passwords lists
account recovery and logging out everywhere as ways one stops working; and the thirty-device cap kills the oldest token
without a word. So a `401` is a re-grant, not a bug. Mason cannot see any of it — it holds the MCP URL, nothing upstream
— so the container says it: a `health` tool on each namespace reports whether the grant is present, how old it is and
what last failed, never the credential, and a `401` that survives a refresh is a hard tool error naming the grant rather
than an empty listing. The Mail note puts that report in `/api/integrations`; it cannot be there, for the same reason it
cannot be in mason at all.
- **One container is one blast radius.** A parse failure in MIME decoding takes Calendar down with it. Accepted: three
endpoints over one credential store is less code than three of everything, and the failure is one restart away.
- **None of the three entries is `required`.** A face whose container is down loses its tools and says so in
`/api/integrations`; one dead container must not refuse the boot. The three entries can also drift apart — enabled
here, disabled there — and `npm run integration -- list` is where that shows.
- **Calendar write and mail send are not decided here.** Both are one switch away and both need an approval surface the
bot does not have yet.

