# Yandex as an agent's second pair of hands — research run, 2026-10-26

> **Ordered later, 2026-11-02.** Gmail and Google Calendar come first for the application bot
> ([`../../APPLICATION-PLAN.md`](../../APPLICATION-PLAN.md)); this run stays as written and is the design for when Yandex
> is built ([`../../adr/0008-three-yandex-integrations-one-container.md`](../../adr/0008-three-yandex-integrations-one-container.md)).

Goal: decide whether mason should reach Denis's Yandex services, and if so what each one actually costs to integrate.
Three surfaces, three protocols, and three different answers: Disk is one OAuth token and a dozen endpoints, Calendar
is CalDAV with a password that never expires, Mail is IMAP/SMTP with an error taxonomy nobody has written down.

**107 sources**, nearly all primary: Yandex's own API reference (read as the `.md` source of the docs site), the Yandex
ID OAuth reference, the API terms of use, the 360 help pages, the relevant RFCs, and the source of the community MCP
servers at a pinned commit. Facts carry a source; `[inference]` marks reasoning rather than evidence. One live probe
against the Disk API is recorded inline and marked as such.

## The short version

| Surface | Protocol | Grant | Can it push? | Verdict |
|---|---|---|---|---|
| [Disk](01-yandex-disk.md) | REST, `cloud-api.yandex.net/v1` | OAuth app, device flow or redirect to `verification_code` | No — poll `last-uploaded` | **Build**, small. Start on the app folder (`app:/`) so the agent cannot touch the owner's own files |
| [Calendar](02-yandex-calendar.md) | CalDAV (`caldav.yandex.ru`), HTTP Basic | App password for the "CalDAV client" app type; 2–3 h activation; no expiry | No — `sync-collection` poll | **Build**, medium, read-only first. `DEVELOPMENT.md` from best-doctor is the quirks specification |
| [Mail](03-yandex-mail.md) | IMAP4rev1 + SMTP submission | App password (whole mailbox) or OAuth `mail:imap_ro` + `mail:smtp` | `IDLE` exists (server advertises it) | **Build**, medium — the biggest of the three, and the one with a real job (triage and draft) |

None of the three has a webhook. All three are outbound-only, which is the fence mason already has: the integrations
need `mason-egress` and nothing else.

## The three decisions the notes ask for

1. **Mail: app password or OAuth?** OAuth gives a read-only scope (`mail:imap_ro`) and a `mail:smtp` that must be granted
   separately, at the cost of a token refresh path. An app password is one field, works in five minutes, and hands over
   the whole mailbox. The notes recommend OAuth for a deployment someone else will run, and an app password for a single
   owner's own mailbox — which is this case.
2. **Disk: prove the device flow before building on it.** Whether an *API access* app may use `POST /device/code` is the
   one unverified fact in the set. One curl script settles it, and it decides whether the sign-in mechanism in the
   [auth plan](../../BACKEND-PLAN.md) can be a code a person types in a chat, or has to be a redirect page.
3. **Write or read-only first, for Calendar and Mail alike.** Both notes land on the same answer independently: read,
   list, summarise and draft; nothing that mails a third party, deletes an event or rewrites a series, until the agent
   has been running for a while and has earned it.

## What building them would mean

All three are the `mason-telegram` shape — one container, an MCP face on `:8082`, a poller for the trigger face, state on
`/data`, a secret minted with `npm run integration -- secret`. No new dependency in mason itself, no new door in
`src/server/`. Which is the point of ADR-0003: a service is a service, and the vendor's protocol stops in the container
that understands it.

Rough sizes, from the notes: Disk ≈ 500–700 lines, Calendar ≈ 2–4 days mostly iCalendar care, Mail ≈ 1 200–1 800 lines
mostly MIME and charset decoding. Mail is the only one where the *error taxonomy* is the work: "authentication failed"
can mean four different things at Yandex and only one of them is fixable by the agent.

## Files

| File | What it covers | Sources |
|---|---|---|
| [01-yandex-disk.md](01-yandex-disk.md) | Disk: the REST API, the OAuth app and the device flow, `app:/` versus `disk:/`, quotas, the fourteen tools a container would offer, the poller, and the month-two failure | 45 |
| [02-yandex-calendar.md](02-yandex-calendar.md) | Calendar: CalDAV, the app password, the collections (events and tasks are separate), `sync-collection`, the write hazards, and what a read-only v1 should refuse to do | 25 |
| [03-yandex-mail.md](03-yandex-mail.md) | Mail: IMAP and SMTP, the two grants, the REST API that cannot send and is 360-only, MIME and Cyrillic folder names, `IDLE`, and the error strings that are the whole taxonomy | 37 |

## What these notes do not cover

- **The link-based sign-in mechanism itself.** It is a mason-side design, not a Yandex one: one grant page, a single-use
  link in a DM, a credential the integration owns. It is specified in [`../../BACKEND-PLAN.md`](../../BACKEND-PLAN.md) once the
  Mail and Disk decisions above are made.
- **A new integration for Mail's REST API.** It is 360-only and cannot send, so it would be a second way to read a mailbox
  the IMAP client already reads.
