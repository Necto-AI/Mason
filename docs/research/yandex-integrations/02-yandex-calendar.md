# Yandex Calendar — a CalDAV server, an app password, and nothing that can push

> Research note, 2026-10-26. Yandex Calendar has no public REST API and no webhooks: it is a CalDAV server
> (`caldav.yandex.ru`, RFC 4791) that a client reaches with HTTP Basic — an app password created for the
> "CalDAV client" app type, or, only inside Yandex 360 for business, a short-lived OAuth token used *as* that
> password. Events and tasks live in separate collections, reminders are a `VALARM` the server asks the client
> to fire, and there is no server-side push of any kind, so a mason integration's trigger face must poll.
> 25 sources.
>
> Written for `docs/research/yandex-integrations/`. Facts carry their source; `[inference]` marks reasoning,
> not evidence. Where a claim rests on someone's live testing rather than on Yandex's own words, the source
> line says so.

## 1. What the API is

- **Transport: CalDAV over HTTPS, Basic auth.** Yandex's own sync instructions name the protocol and the
  endpoint: "Календари синхронизируются по протоколу CalDAV", server `caldav.yandex.ru`, path
  `/principals/users/<login>@<domain>/`, port `443` or `8443`, SSL on, Kerberos off, user name
  `login@domain`, password "пароль приложения, созданный на предыдущем шаге" [2][3]. Mobile uses the same
  server with `https://caldav.yandex.ru` and adds a troubleshooting note: if the full address fails, try the
  login without the domain [4].
- **There is no public REST calendar API.** The Yandex 360 API introduction says outright what its REST
  surface covers: "Через API можно работать со следующими сущностями: сотрудники, группы и подразделения;
  правила маршрутизации почты; двухфакторная аутентификация пользователей; аудит-логи" [11]. The API
  reference's resource index lists Mail, Domain, Group, User, AuditLog, 2FA, Sessions, ServiceApplications —
  and no calendar resource [15]. Yandex ID's OAuth API returns identity only ("Логин, имя и фамилия, пол;
  Портрет; Адрес электронной почты; Номер телефона; Дата рождения") [16].
- **A calendar OAuth scope exists, and it is consumed by CalDAV.** The service-application endpoint enumerates
  the scopes a Yandex 360 organization may grant: `calendar:all`, `calendar:read_all`, `calendar:write_all`,
  `calendar:events.read`, `calendar:events.write`, `calendar:calendars.read`, `calendar:calendars.write`,
  `calendar:free_busy.read`, `calendar:resources.read`, `calendar:my_settings.read/write` [14]. And the admin
  documentation says where those tokens go: **"С использованием OAuth-токенов можно взаимодействовать с
  Яндекс Календарем пользователей по протоколу CalDAV."** The page's own Python example passes the token as
  the *password*: `caldav.DAVClient(url="https://caldav.yandex.ru/", username=username, password=leg_token)`
  [13]. So OAuth works against CalDAV — not as `Authorization: Bearer`, but as a Basic-auth password. The
  token there is minted by token-exchange per user and **lives one hour**: "Срок действия временного токена —
  1 час" [13].
- **The objects are iCalendar resources at predictable URLs.** The same page writes events by `PUT` to
  `https://caldav.yandex.ru/calendars/<user_email>/events-default/<event_uid>.ics`, and documents one
  non-standard property: `X-TELEMOST-REQUIRED` inside the `VEVENT` makes the server generate a Telemost
  conference link and append it to the description [13]. Live probing of an account lists the collections as
  `/calendars/<login>%40yandex.ru/inbox/`, `/outbox/`, `events-27127/`, `events-8486495/`, … and
  `todos-86503/` — the default calendar is `events-default`, and tasks are their own collection family
  [24][20].
- **Events and tasks do not share a collection.** Collection names beginning `events-` accept only `VEVENT`,
  `todos-` only `VTODO`; asking for the wrong component makes the server return the whole collection
  unfiltered, so a client must query only collections whose supported-component set matches [20, live-tested
  account].
- **Tasks are real.** Yandex Calendar has to-do lists with due dates and an overdue tab [10], and Yandex's own
  Outlook connector "синхронизирует календарь, видеовстречи, задачи и контакты … по протоколам CalDAV и
  CardDAV" [9]. `[inference]` Tasks are therefore `VTODO` in the `todos-*` collections; Yandex's docs never
  use the word VTODO, but the live-tested client reports creating and completing them in `todos-*` [20].
- **Reminders are `VALARM`s delivered through the client.** The notifications page lists the delivery channel
  literally as "через CalDAV — отправить напоминание в сторонние календарные программы, синхронизированные с
  Яндекс Календарем", settable per calendar and per event [5][6]. Its channel table is the important half:
  third-party apps and schedulers get **reminders** (✅) but **not** invitation/change/cancel notices (❌)
  [5]. `[inference]` So an agent that writes `VALARM` gets a reminder fired by whatever device syncs; an agent
  that writes an `ATTENDEE` gets the invitation mailed by the server (see §6).
- **Scheduling is server-side.** The server advertises `calendar-auto-schedule`, exposes `schedule-inbox` /
  `schedule-outbox`, answers `VFREEBUSY` POSTs with `BUSY` / `BUSY-TENTATIVE`, and publishes the owner's
  primary calendar as `schedule-default-calendar-URL` (RFC 6638) [20]. A plain free-busy `REPORT` on a
  collection is answered `400` [20].
- **iCal export exists, as a link, owner-only.** Export offers "iCal, HTML и протокол CalDAV": the iCal link is
  a subscription URL (opening it downloads an `.ics`), and "Ссылки в форматах iCal и HTML доступны для
  экспорта только владельцу календаря, для остальных пользователей доступна только ссылка для CalDAV"
  [7][8]. `[inference]` The iCal link is a per-calendar secret URL rather than an authenticated API - Yandex
  documents sharing it by sending it to another person - but I did not verify its format or whether it carries
  a revocable token, so treat it as read-only convenience, not as an interface.

## 2. Auth: how a human grants the agent access, and what is stored where

The path for a personal account, verified end to end in Yandex's docs and in a client's integration notes:

1. **Create the app password.** id.yandex.ru → Безопасность → "Доступ к вашим данным" → Пароли приложений →
   "Создать пароль приложения" → app type **"CalDAV-клиент для Яндекс Календаря"** (the English page calls
   the type "CalDAV client for Yandex Calendar"; the mobile flow's picker says just "Calendar") [1][3][4].
2. **Copy it immediately.** "Созданный пароль можно увидеть только один раз" [1].
3. **Wait.** "Пароль начнет действовать через 2–3 часа" [1]. This is the first boring trap: a container that
   treats the first `401` as a bad credential will crash-loop for three hours on a perfectly good password.
4. **Configure the client.** Server `https://caldav.yandex.ru`, principal
   `/principals/users/<login>@<domain>/`, Basic auth, `<login>@<domain>` as the user name — falling back to the
   bare login if the full address is rejected [2][3][4]. No redirect URI, no OAuth application, no consent
   screen, no developer console: for a personal account the whole grant is one password field [1][2].
5. **Where it is stored.** Per ADR-0003 the integration owns its upstream credential, so the login and the app
   password live in the container's environment (`deploy/.env`), never in `service/integrations.json`; mason
   holds only the MCP URL and the trigger secret. Inside the container they must be read once at boot, held in
   memory, and never logged or echoed into a tool result — the app password is a full read/write grant on the
   calendar, not a scoped capability (see §5 for why the *tool surface*, not the credential, is the fence).
6. **What else is on disk.** Nothing about the password; state is protocol state — per-calendar `sync-token`,
   the ETag of anything the agent intends to edit, the last poll watermark — on the container's own volume
   (`/data`), `0600`, written whole via temp-file-and-rename, exactly like `mason-telegram`'s `offset.json`.

**Yandex 360 for business is a different, harder path**, and it is the only documented OAuth path: the org
owner registers an OAuth app, activates service applications
(`POST https://api360.yandex.net/security/v1/org/<org_id>/service_applications/activate`), registers a second
OAuth app as a service application with the calendar scopes, then mints a per-user token by token-exchange
(`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<user_email>`,
`subject_token_type=urn:yandex:params:oauth:token-type:uid|email`) and passes it as the CalDAV password [13].
Tokens last an hour [13], app passwords can be forbidden by an org admin `[inference from 13's framing of
admin-controlled access; the community client states the ban is admin-released]`, and personal `@yandex.ru`
accounts have no organization to register anything in [16].

**Is a phone required?** No source states that linking a phone is a precondition for creating an app password
[1]. What is documented is that Yandex challenges a login it finds suspicious — "Вы входите из необычного
места или ваши действия похожи на действия робота" — by SMS or call to "основной номер, привязанный к
вашему Яндекс ID", a control question, or a code to a backup address [17]. `[inference]` A phone-linked
account is therefore not needed to *use* CalDAV, but it is the recovery anchor when Yandex decides the agent's
egress looks unusual, and §6 treats that as the live risk it is.

**Token lifetime.** An app password has no expiry: Yandex documents no TTL, only the conditions that wipe it
(§6) [1]. Nothing refreshes, so an agent that runs for a year uses one credential for a year.

**From a datacenter IP.** Nothing in Yandex's CalDAV documentation restricts source address, and the
integration guides are written for phones and laptops on any network [2][3][4]. What exists is a general
anti-abuse posture: the login-challenge page above [17], and one public report of a Yandex mailbox whose
app-password IMAP access was cut and whose web login began demanding a captcha and SMS, with no documented
reason [25]. That report is about Mail, is single-source, and is not evidence about CalDAV — recorded as an
open risk, not a finding.

## 3. Rate limits, quotas, sizes, and what hits them first

- **No published quota.** I found no Yandex page stating a request rate, daily call budget, response-size cap,
  calendar count, event count, or event size for `caldav.yandex.ru`. The 360 API documentation has an
  "Ограничения" section, but it governs the `api360` REST endpoints, which do not include calendar [11][12].
  This is missing evidence, not a clean bill of health.
- **What practitioners observe** (third-party, live-tested, not Yandex's word):
  - a generic CalDAV MCP server's provider notes claim Yandex "artificially slows down WebDAV operations (60
    seconds per MB since 2021)", with frequent `504 Gateway Timeout` on create/update and advice to sleep 2–5 s
    between writes [22];
  - the most thorough client reports `504` on a `PUT` that tries to restore `EXDATE`s, a first
    `sync-collection` `REPORT` on a large calendar failing with `507 Insufficient Storage` (worked around by
    reading `{DAV:}sync-token` with `PROPFIND` first), a `400` on an unknown sync token, and a multi-year
    collection weighing ~10 MB and taking 15–30 s to return [20].
- **The cliff that actually bites is payload, not rate.** The server ignores a `UID` filter in
  `calendar-query` and returns the whole collection; on a calendar with years of events that is ~10 MB and
  15–30 s *per `get_event`*, so a client must `GET` `<uid>.ics` at the resource URL instead (0.1–0.8 s) [20].
  A polling trigger that resolves one UID per cycle by query would be a self-inflicted DoS.
- **Sizes worth designing around** `[inference, from the above]`: bound every query with a time range (one
  week per `list_events` call), never query a collection without a component filter, and cap what the MCP
  response can carry — mason already truncates, but a 10 MB VCALENDAR should never be built in the first
  place.
- **Change propagation has lag.** A sync-token delta shows a created object after 3–15 s and a deleted one
  after 40–90 s; the deletion record is stamped later than the deletion, so it is not lost by a token already
  handed out [20]. `[inference]` This sets the floor for a poll interval: anything under a minute buys nothing.

## 4. Off-the-shelf MCP servers, with license and maintenance assessment

Metadata below is from the GitHub API on 2026-10-26 (license, last push, stars) [21]; tool lists are from each
project's own README [20][26][22][21].

| Project | Lang / license | Last push | ★ | Tools | Assessment |
|---|---|---|---|---|---|
| [best-doctor/yandex-calendar-mcp](https://github.com/best-doctor/yandex-calendar-mcp) (PyPI `yandex-calendar-mcp` 0.3.0) | Python, MIT | 2026-10-09 | 0 | 19 (12 read, 7 write) | The most complete and the only one that documents a live account's quirks in writing. stdio only, single-user, write mode is one env var, no HTTP transport, no auth. It is a corporate internal tool published as-is. |
| [shanginn/yandex-calendar-plugin](https://github.com/shanginn/yandex-calendar-plugin) | TypeScript, Apache-2.0 | 2026-08-01 | 0 | 6 | Closest in spirit: ETag conflict detection, deletion only after explicit confirmation, no recurrence editing. Packaged as a Codex plugin, not a server. |
| [madbonez/caldav-mcp](https://github.com/madbonez/caldav-mcp) | Python, **no license** | 2025-11-28 | 15 | 9 | Created and last pushed the same day. Generic CalDAV (Yandex, Google, Nextcloud). No license means no permission to reuse — a blocker, not a risk factor. |
| [NextStat/yacli](https://github.com/NextStat/yacli) | Rust, MIT | 2026-03-15 | 27 | calendar + mail + disk | The most maintained-looking of the set: CLI + MCP with stdio **and** `--transport http`, prompts, resources. Broad product, single author, calendar is a slice of it. |
| [akinfold/hermes-yandex-calendar](https://github.com/akinfold/hermes-yandex-calendar) | Python, MIT | 2026-10-20 | 1 | 7 | Newest. Calendar allowlist and per-action gating (`read`, `read,write`), recurrence/alarm preservation, move-by-copy-then-delete. Hermes-plugin packaging. |
| [colibri11/yad](https://github.com/colibri11/yad) | TypeScript, MIT | 2026-06-15 | 1 | 5 calendar of 26 total | Mail + Calendar + Disk + Contacts in one server; documents the app-password requirement plainly. Thin. |
| [agorlov/yandex-calendar-mcp](https://github.com/agorlov/yandex-calendar-mcp) | Python, **no license** | 2025-04-13 | 3 | 3 | Three tools, calendar discovery by scraping HTML. Reference only. |

**What this adds up to.** Seven independent attempts, all solo, all ≤10 months old at the time of writing, none
with a second maintainer visible and none with an issue budget worth relying on; two carry no license at all
[21]. The design they converge on is also the wrong shape for mason: every one is stdio and single-user, so
none can sit behind `http://mason-yandex-calendar:8082/mcp`. `[inference]` The reusable assets are not the
servers but two documents: best-doctor's `docs/DEVELOPMENT.md`, which is a 40-line catalogue of exactly the
Yandex behaviours that will cost a week to rediscover [20], and shanginn's `If-Match`/confirmation discipline
[26]. Nothing off the shelf should be deployed as-is.

## 5. What the mason integration would look like

**Shape.** One container, `mason-yandex-calendar`, in its own `compose.calendar.yaml` (not a comment, per
`deploy/README.md`), joining `mason-mcp` and `mason-edge`; it listens on `:8082/mcp` inside `mason-mcp` only
and publishes nothing. It holds the login and the app password; mason holds
`{"tools":{"url":"http://mason-yandex-calendar:8082/mcp"},"description":"The owner's Yandex Calendar: events, tasks and free slots"}`,
and — if the trigger ships — one trigger secret. Node 22, TypeScript from source with
`--experimental-strip-types`, no build step, in the shape of `integrations/telegram`. `[inference]` The one
dependency decision worth making early: use `tsdav` + `ical.js` rather than writing CalDAV or iCalendar by
hand; the Python `caldav` ecosystem is more battle-tested [20] but breaks the house Node-22 convention, and
writing RFC 5545 by hand is how the recurrence bugs in §6 happen.

### The tools face — MCP over Streamable HTTP on `:8082/mcp`

The credential is read/write on every calendar in the account, including calendars colleagues have shared with
it. The fence therefore has to be the tool surface: no delete, no attendee, no raw iCalendar in, and a default
that reads. Two modes, one image: `read` (default) and `write`, where `write` adds exactly three tools.

Read, always on:

| Tool | What it does |
|---|---|
| `list_calendars()` | The calendars this account owns or subscribes to — `{id, name, url, components}` — so the agent never guesses a calendar id. |
| `list_events(from, to, calendar_id?)` | Events in one bounded window (7 days by default, 31 maximum), recurrences expanded, one line each with `uid`, time, title. |
| `get_event(uid)` | One event by `uid`: attendees with their RSVP status, organiser, location, Telemost link. |
| `list_todos(calendar_id?)` | Open tasks with due dates, `todos-*` collections only. |
| `find_free_slots(from, to, minutes, working_hours?)` | Free windows computed locally from the busy events of the chosen calendars — never a server `freebusy` `REPORT`, which answers `400` on a collection. |
| `sync_changes(calendar_id, sync_token?)` | `{token, upserts[], deleted_urls[]}` from RFC 6578 `sync-collection`; the first call returns only a token, because a first `REPORT` on a big calendar answers `507`. |

Write, only when `YANDEX_CALENDAR_MODE=write`:

| Tool | What it does | Annotation |
|---|---|---|
| `create_event(calendar_id, summary, start, end, location?, description?)` | Creates one event, or a series from an `RRULE`. Never takes attendees: the server would mail invitations, and this container must not be able to write to strangers. | write |
| `update_event(uid, fields, if_match)` | Moves or renames one event or one series. `if_match` is the ETag the agent read; a `412` comes back to the model as a conflict, not a retry. Refuses a series move when the series has deleted instances (they would resurrect — §6). | write |
| `create_todo(calendar_id?, summary, due?)` | Adds a `VTODO` to a `todos-*` list. | write |

Nothing else is offered: no `delete_event`, no `delete_calendar`, no `respond_to_invite`, no attendee
add/remove, no raw `PUT`. `[inference]` A "cancel this event" capability is a v2 decision that needs an
approval surface mason does not have yet; shipping `delete_event` in v1 because the API allows `DELETE` would
put a destructive verb behind a prompt injection in an email the agent can also read.

### The trigger face — polling, because there is nothing to be woken by

There is no webhook, no push subscription, no change notification: CalDAV's only change mechanism is RFC 6578
`sync-collection`, which the client polls [20], and the third-party integration documentation says it plainly
in its limitations — "push-подписок на CalDAV-сервер нет", "автоматической синхронизации нет" [23]. Yandex
publishes nothing resembling a push API for Calendar [missing evidence — searched the Calendar help and the
360 API reference].

So the trigger is a poller with the same contract as `mason-telegram`'s offset:

1. Every `POLL_INTERVAL` (default `PT5M`, floor one minute — the delta itself lags 3–15 s), for each
   allowlisted calendar: `PROPFIND {DAV:}sync-token`, then `sync-collection` `REPORT` with the stored token
   [20].
2. For each changed object, one signed POST to `MASON_EVENT_URL` (`POST /api/events/yandex-calendar` on the
   mason side) with `x-mason-signature: sha256=<hex hmac-sha256 of the raw body>` and the v1 envelope:
   ```json
   {"v":1,"id":"yc-<seq>-<uid>","kind":"calendar.event",
    "payload":"Work: 'Standup' Tue 2026-10-27 10:00–10:15 Europe/Moscow (uid 4f2a…)"}
   ```
   For deletions, `payload` reads `Work: 'Standup' Tue 2026-10-27 10:00 deleted (uid 4f2a…)`; the calendar
   name is inside the payload on purpose, because `payload` is a string and the reply needs the id.
3. `id` is `yc-<sync-seq>-<uid>`, where `sync-seq` is the integer in the server's `sync-token:1 <unix ms>`
   [20]. Redelivery after a crash therefore lands on the same id and the door's permanent dedupe turns it into
   one fire; a later change to the same object carries a later seq and is a new event.
4. `202` expected. A refusal (`400`/`401`/`404`/`405`/`413`) advances the token anyway — the door will never
   accept that envelope and holding the token would block every change behind it. `429` honours `retry-after`.
   An unreachable door does **not** advance the token: the same batch is re-posted with the same ids.
5. On first boot with no state the poller reads the current `sync-token`, stores it, and fires nothing — a
   restart must never replay last month's calendar into the agent, exactly as the Telegram offset discards its
   backlog.
6. A `401` is not a transport error and must not be retried as one: it is `calendar.auth_failed`, one event out
   (see §6) and a health flag, not a silent loop.

`[inference]` A three-hour calendar delta is not worth a per-change event for most purposes; a `digest` hook
firing once in the morning ("today: 4 events, 2 tasks due") would use the same event door and cost fewer
tokens. Ship the per-change poller only if the agent is expected to react within minutes.

### Configuration

| Variable | Required | What it is |
|---|---|---|
| `YANDEX_CALDAV_LOGIN` | yes | Full address, `user@yandex.ru` or `user@company.ru`. |
| `YANDEX_CALDAV_APP_PASSWORD` | yes | The Calendar app password. Never logged, never in a payload, never in a tool result. |
| `YANDEX_CALENDARS` | yes | Comma-separated calendar ids or exact collection URLs this container may touch. An instance without it would reach every calendar shared with the account, including colleagues' subscribed layers. |
| `YANDEX_CALENDAR_MODE` | no | `read` (default) or `write`. `write` adds the three write tools and nothing else. |
| `YANDEX_CALDAV_TZ` | no | IANA zone for rendering and for `DTSTART;TZID=`; defaults to `Europe/Moscow`. Writing in UTC is wrong — a series in a DST zone shifts by an hour after the transition. |
| `MASON_EVENT_URL` | trigger only | `http://mason:8787/api/events/yandex-calendar`. |
| `MASON_TRIGGER_SECRET` | trigger only | The HMAC key, ≥32 chars, minted by `npm run integration -- secret yandex-calendar --hook calendar-change`. |
| `POLL_INTERVAL` | no | ISO 8601 duration, default `PT5M`, floor `PT1M`. |
| `HTTPS_PROXY` | no | Only if the egress sidecar is the route; Node's `fetch` ignores it, so it needs `undici`'s `ProxyAgent` as in `integrations/telegram/src/fetch.ts`. |
| `DATA_DIR` / `PORT` | no | `/data`, `8082`. Moving the port means moving `tools.url`. |

Volumes: `/data` only — `state.json` (per-calendar sync tokens, last poll, last auth failure) and
`auth-state.json` (whether the app password has been accepted yet, so the 2–3 hour activation window is a
warning and not a crash loop).

### Where it sits relative to the fence

Outbound HTTPS to `caldav.yandex.ru:443` only. No inbound anything: no webhook to receive, no port to publish,
no DNS beyond the compose network. `[inference]` The container is therefore strictly easier to place than
`mason-telegram` — Yandex Calendar is not a service that needs the sidecar to be reachable at all; if the
sidecar exists to keep one exit country, join `mason-egress` and route through it, and if it exists only for
Telegram, `mason-edge` is enough. The one caveat: the exit IP becomes the account's "usual place", and §6 is
about what Yandex does when that changes.

## 6. Risks and the month-two failure

1. **The app password is wiped by something the human does in another tab.** Yandex's own list: "Все созданные
   вами пароли приложений сбрасываются в следующих случаях: вы восстановили доступ к своему аккаунту,
   самостоятельно или через службу поддержки; вы перешли по ссылке Выйти на всех устройствах в разделе
   Устройства" [1]. One account-recovery flow, one "sign out everywhere" after a lost phone, and every app
   password dies at once. This is the month-two failure: the agent does not crash, it just stops seeing
   anything, and "no events today" reads like a quiet day. Mitigations: make `401` a distinct, loud state
   (one `calendar.auth_failed` event, a line in `/api/integrations`, a tool error the model can report), and
   never let an auth failure render as an empty list.
2. **The first three hours look exactly like a wrong password.** "Пароль начнет действовать через 2–3 часа"
   [1]. A container with a restart policy and no state will `401`-loop, and the natural debugging move — delete
   the password and mint another — resets the clock.
3. **An `update` is more destructive than a delete here.** Yandex drops every `EXDATE` when a series' start
   time is moved, so cancelled instances resurrect; restoring them by `PUT` gets `504` "even after a minute",
   so the damage is permanent [20]. `[inference]` An agent asked to "move the standup to Thursday" is one
   `RRULE` `PUT` away from resurrecting a year of cancelled occurrences. The tool must refuse that shape
   (§5 `update_event`) rather than trust the model to remember.
4. **Attendees are a mail cannon with a silent-save footgun.** A `VEVENT` with `ATTENDEE`s but no `ORGANIZER`
   is saved as a private event: Yandex silently discards the attendees, writes its own `ORGANIZER`, and
   answers success [20]. With an `ORGANIZER`, the server mails invitations and cancellations itself
   (`calendar-auto-schedule`) [20] — and third-party clients do not receive the invitation notices, only the
   reminders [5]. Two failure modes from one field: silent data loss, or mail to people the owner never chose.
   Hence: no attendee parameter at all in v1.
5. **The OAuth-in-a-password trick is undocumented outside Yandex 360 for business and may change.** It is
   stated on an admin help page, not in an API reference, and the tokens last an hour [13]. `[inference]`
   Nothing about a personal account needs it, so the integration should not depend on it; if a business
   account ever needs it, keep it behind the same env var and treat a `401` as possibly "the token aged out"
   as well as "the password died".
6. **Account-level anti-abuse, not API rate limits.** Yandex challenges a login from "необычного места" or one
   that "похожи на действия робота" with SMS, a control question or a backup-address code [17]; there is one
   public report of a Yandex account whose app-password automation was cut and whose web login began demanding
   captcha and SMS, with no documented reason [25]. `[inference]` A datacenter IP behind a VPN sidecar is a
   plausible trigger, and the failure is account-wide, not calendar-scoped. Not verified for CalDAV; it is the
   first thing to watch in the logs.
7. **Deprecation is not the risk it usually is.** CalDAV is RFC 4791 and Yandex has shipped it for over a
   decade; the documented endpoint path (`/principals/users/…`, `events-default`) appears in Yandex's own
   business documentation today [2][13]. `[inference]` The deprecation risk sits on the unofficial surfaces an
   implementer might be tempted into — the web app's internal JSON API, the export link format, the
   `/.well-known/caldav` discovery path (which answers `404`) [20] — not on the protocol.
8. **Terms of service: not checked.** I did not read the Yandex 360 / Yandex ID user agreement for clauses on
   automated access, so I cannot say whether unattended polling is permitted. Recorded as missing evidence, and
   worth ten minutes before this ships.

## 7. Recommendation

Build it, read-only first, as a **medium** piece of work — call it two to four days including tests, most of it
iCalendar care rather than plumbing. The case is unusually clean for a mason integration: the protocol is a
15-year-old RFC with no vendor lock-in, the grant is one password field with no OAuth app and no redirect URI,
the credential has no expiry, the whole surface is outbound HTTPS with nothing to expose inbound, and the
account's data is already in iCalendar, which is the format the agent would have to reason about anyway. What
is *not* clean is everything around writes: reminders are provider-side, invitations are mailed by the server,
recurrence edits can resurrect deleted occurrences, and there is no push of any kind — so the integration's
honest v1 is "read the calendar, find free time, list tasks, and tell the owner", with a poll-based trigger
that fires on changes and a write mode that can create and move but never delete, never invite, and never
rewrite a series with deleted instances. Take best-doctor's `DEVELOPMENT.md` as the specification of Yandex's
quirks (it is worth more than any of the seven servers' code), take shanginn's `If-Match` discipline, and write
the container in the `mason-telegram` shape: stateless `/mcp` on `:8082`, injected DAV client for offline
tests, state on `/data`, one trigger secret.

First three steps:

1. **An hour with the real account, before any code.** Create the Calendar app password, wait out the 2–3
   hours, then with `curl` alone: `PROPFIND /principals/users/<email>/`, `GET /calendars/<email>/` (the server
   answers a collection list to a plain `GET`, which is *not* what RFC 4791 says [20][24]), `PROPFIND Depth:1`
   on `events-default` and on a `todos-*` collection, and one `sync-collection REPORT`. Save the raw
   `VCALENDAR` of a real recurring event and of a task to `test/fixtures/`. This settles `events-default` vs
   `events-N`, confirms the activation delay, and gives the parser its ground truth.
2. **The container skeleton and the six read tools, no writes, no poller.** Fork the `mason-telegram` layout:
   `src/server.ts` with one `McpServer` per request, `src/caldav.ts` behind an injected transport so the suite
   runs with no sockets, `list_calendars` / `list_events` / `get_event` / `list_todos` / `find_free_slots` /
   `sync_changes`. Reject any window over 31 days and any `todos-*` query for `VEVENT`. Ship the one-line
   `description` mason will show the model.
3. **The trigger, and the hook on mason's side.** `state.json` with per-calendar sync tokens, the poller, the
   `yc-<seq>-<uid>` ids, the five refusal answers and the `429` rule copied from
   `integrations/telegram/README.md`, the `calendar-change` hook in `src/server/hooks.ts`, and a
   `compose.calendar.yaml` service. Only after that is stable: `YANDEX_CALENDAR_MODE=write` with the three
   tools, plus an explicit test that a series with an `EXDATE` is refused a move.

## Open questions

- **The iCal export link's shape.** Yandex documents that it exists, that it is owner-only, and that opening it
  downloads an `.ics` [7][8]; it does not document whether the URL carries a revocable token, whether it can be
  regenerated, or whether it is readable without a session. Unverified. It matters only if a read-only mirror
  is ever preferred to CalDAV — and it should not be, because the link cannot be scoped or revoked per device.
- **Any rate limit at all.** No Yandex page states one for `caldav.yandex.ru` [missing evidence]. The
  "60 seconds per MB" figure is a third-party claim [22] and reads like an interpretation of `504`s rather
  than a documented rule `[inference]`.
- **Whether Yandex writes `VALARM` for a channel set to CalDAV, or expects the client to.** The notifications
  page says the reminder is *delivered* "через CalDAV" [5]; the live-tested client reads and preserves alarms
  but does not say where they come from [20]. Unverified — and it decides whether `create_event` should write
  its own `VALARM` or leave reminders to the owner's calendar settings.
- **Whether a personal `@yandex.ru` account can request `calendar:*` scopes at all.** The scopes are documented
  for service applications in an organization [14][13]; the Yandex ID OAuth documentation lists only profile
  data [16]. No source says a personal OAuth app can be granted calendar access, and the CalDAV path does not
  need one.
- **Terms of service.** Not read (§6.8).
- **`respond_to_invite` and invitations from other people.** No source documents a reliable way to answer an
  invitation over CalDAV on Yandex; the most thorough client explicitly left it untested because it needs
  someone else's invitation [20]. Out of scope for v1, but it is the one capability an always-on assistant
  would plausibly want next.

## Sources

1. Пароли приложений (Yandex ID) — https://yandex.ru/support/id/authorization/app-passwords.html (direct) — read 2026-10-26. App types including "CalDAV-клиент для Яндекс Календаря", one-time display, 2–3 hour activation, the reset list.
2. Календарь на компьютере — https://yandex.ru/support/yandex-360/business/calendar/ru/data-exchange/synchronization/sync-desktop (direct) — read 2026-10-26. CalDAV server/path/port/SSL settings.
3. Yandex Calendar for desktop (EN) — https://yandex.com/support/yandex-360/business/calendar/en/sync/sync-desktop (direct) — read 2026-10-26.
4. Календарь на мобильном устройстве — https://yandex.ru/support/yandex-360/business/calendar/ru/data-exchange/synchronization/sync-mobile (direct) — read 2026-10-26. `https://caldav.yandex.ru`, and the "user name without domain" fallback.
5. Уведомления о событиях — https://yandex.ru/support/yandex-360/customers/calendar/web/ru/plan-events/notifications (direct) — read 2026-10-26. The channel table; "через CalDAV" as a reminder channel.
6. Managing event notifications (EN) — https://yandex.com/support/yandex-360/customers/calendar/web/en/event-notification (direct) — read 2026-10-26.
7. Перенести события в другой сервис — https://yandex.ru/support/yandex-360/customers/calendar/web/ru/data-exchange/export (fetched) and https://yandex.ru/support/yandex-360/business/calendar/ru/data-exchange/export (search) — read 2026-10-26. iCal/HTML/CalDAV export; owner-only iCal and HTML links.
8. Поделиться календарем — https://yandex.ru/support/yandex-360/business/calendar/ru/sharing (search) — read 2026-10-26. "Ссылки в форматах iCal и HTML доступны для экспорта только владельцу календаря".
9. Расширение Яндекс Коннектор для Microsoft Outlook — https://yandex.ru/support/yandex-360/business/calendar/ru/plug-in (direct) — read 2026-10-26. Calendar + video meetings + tasks + contacts over CalDAV/CardDAV.
10. Записывать дела и задачи — https://yandex.ru/support/yandex-360/customers/calendar/web/ru/reminders/to-do (search) — read 2026-10-26. To-do lists, due dates, overdue.
11. Яндекс 360 API — Введение — https://yandex.ru/dev/api360/doc/ru/ (fetched) — read 2026-10-26. The REST surface covers employees, groups, departments, mail routing, 2FA, audit logs.
12. Яндекс 360 API — Доступ к API — https://yandex.ru/dev/api360/doc/ru/access (search) — read 2026-10-26. OAuth app registration, Redirect URI, scope list at `oauth.yandex.ru/client/<id>/info`.
13. Сервисные приложения (Yandex 360 for business admin help) — https://yandex.ru/support/yandex-360/business/admin/ru/security-service-applications (fetched) — read 2026-10-26. The decisive page: "С использованием OAuth-токенов можно взаимодействовать с Яндекс Календарем пользователей по протоколу CalDAV"; token-exchange, 1-hour token; `PUT /calendars/<email>/events-default/<uid>.ics`; `X-TELEMOST-REQUIRED`.
14. Создать список приложений — ServiceApplicationsService_Create — https://yandex.ru/dev/api360/doc/ru/ref/ServiceApplicationsService/ServiceApplicationsService_Create (search) — read 2026-10-26. The full `calendar:*` scope list.
15. Справочник API 360 (resource index) — https://yandex.ru/dev/api360/doc/ru/ref/ (fetched) — read 2026-10-26. No calendar resource.
16. OAuth для Яндекс ID — О сервисе — https://yandex.ru/dev/id/doc/ru/ (fetched) — read 2026-10-26. Identity data only.
17. Проверка при входе — https://yandex.ru/support/id/ru/security/login-challenge-form (search) — read 2026-10-26. "необычное место", "похожи на действия робота" → SMS/call to the linked number, control question, backup e-mail.
18. DAVx⁵ — tested with Yandex — https://www.davx5.com/tested-with/yandex (fetched) — read 2026-10-26. Settings as shipped for a real client: app password, `https://caldav.yandex.ru`, no OAuth option.
19. DAVx⁵ manual §1.3.1, provider-specific login — https://manual.davx5.com/introduction.html (search) — read 2026-10-26. OAuth is used for Fastmail and Google; Yandex is not on that list.
20. best-doctor/yandex-calendar-mcp — https://github.com/best-doctor/yandex-calendar-mcp, raw `docs/DEVELOPMENT.md`, PyPI https://pypi.org/project/yandex-calendar-mcp/ — read 2026-10-26. MIT, 19 tools. The richest source on Yandex's CalDAV behaviour: live-tested quirks (no `/.well-known`, `events-*`/`todos-*` split, UID filter ignored, ETag/`If-Match` 412, auto-schedule, `ORGANIZER` requirement, sync-token format, `507`, delta lag, `EXDATE` loss on series move, `COUNT`→`UNTIL`). Third-party, single account — treated as strong but non-vendor evidence.
21. GitHub repository metadata for the seven candidate servers (license, `pushed_at`, stars) — `api.github.com/repos/{madbonez/caldav-mcp, best-doctor/yandex-calendar-mcp, shanginn/yandex-calendar-plugin, agorlov/yandex-calendar-mcp, colibri11/yad, akinfold/hermes-yandex-calendar, NextStat/yacli}` — read 2026-10-26.
22. madbonez/caldav-mcp — `PROVIDER_NOTES.md` — https://github.com/madbonez/caldav-mcp — read 2026-10-26. The "60 seconds per MB since 2021" throttling claim and 504-on-write advice. Third-party, unverified; the repo itself has no license.
23. Провайдер CalDAV (1Forma help) — https://help.1forma.ru/domains/calendar/provider-caldav/ (search) — read 2026-10-26. A vendor integrating Yandex CalDAV: discovery by `GET` not `PROPFIND`, attendees written in two passes, "push-подписок на CalDAV-сервер нет".
24. RSDN thread on creating a Yandex calendar over CalDAV — https://rsdn.org/forum/dotnet/8264445.1 (search) — read 2026-10-26. The collection listing (`events-27127`, `todos-86503`, `inbox`, `outbox`) from a real account; a plain `GET` on `/calendars/<login>@yandex.ru/` returns the calendar URLs.
25. Yandex email account gets blocked even though authenticated by app password — https://stackoverflow.com/questions/64672187/yandex-email-account-gets-blocked-even-though-authenticated-by-app-password (search) — read 2026-10-26. One report, about IMAP: app-password automation cut, captcha + SMS on web login. Not evidence about CalDAV; recorded as risk.
26. shanginn/yandex-calendar-plugin — https://github.com/shanginn/yandex-calendar-plugin — read 2026-10-26. Apache-2.0, TypeScript, ETag conflict detection, delete only after explicit confirmation.

**Rejected / deprioritised.** "Яндекс Календарь API: полное руководство по интеграции" (yquunysa.ru, 2026-08-16) — the top
search hit for "Яндекс Календарь API", and fabricated: it describes a REST API with `events` resources, an
official Python/PHP SDK, a sandbox, `X-RateLimit-Remaining`, and a "100 000 calls/day free tier". None of that
exists in Yandex's documentation [11][15], and the same page contradicts itself on its quota numbers. Listed
here so the next reader does not lose an hour to it. Хабр Q&A (2016) on "is there calendar API info" —
superseded by §1. `pikabu` scope list (2025) — redundant with [14]. A proxy vendor's blog on Yandex services
abroad — marketing, and its claims about datacenter IPs and geo-blocking are third-hand; the primary fact it
gestures at is [17], which is enough.
