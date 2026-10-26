# Yandex Mail — IMAP/SMTP with an app password, and a REST API that cannot send

> Research note, 2026-10-26. **37 sources (33 primary)**: Yandex's own help pages, the OAuth and Mail API reference,
> the API's complete endpoint index, and the source metadata of the eight MCP servers found. Four claims rest on
> secondary sources and are marked so; everything else is Yandex's own page or the repo's own metadata. Written for `docs/research/yandex-integrations/`. Facts carry their source;
> `[inference]` marks reasoning, not evidence.

## What it is, in one paragraph

Yandex Mail is not one API. It is a **standard IMAP4rev1 + SMTP-submission mailbox** that every Yandex mailbox has,
authenticated with an app password or an OAuth token over `XOAUTH2`; and, separately, a **REST API** ("API Яндекс
Почты") that lives at `cloud-api.yandex.net/v1/mail` and is **only available to Yandex 360 subscribers**
[5][6]. The REST API is the richer object model — folders, labels, categories, envelopes, threads, counters, filters,
sender lists, autoreply, signatures — but it has **no send and no draft-create operation** [7], so a mail *agent*
still has to speak SMTP to say anything. There is no webhook and no push channel anywhere in the API: the only
"something arrived" signal Yandex offers a program is IMAP `IDLE` [3][7].

---

## 1. What the API is (transport, auth, objects)

### Two surfaces

| | IMAP / SMTP | REST (`cloud-api.yandex.net/v1/mail`) |
|---|---|---|
| Who can use it | every mailbox | "Работа с API Яндекс Почты доступна только пользователям с тарифом Яндекс 360" — 360 subscribers only [5] |
| Auth | app password, or OAuth token via `XOAUTH2` [3] | OAuth token in `Authorization: OAuth <token>` [6] |
| Read mail | yes | yes — envelopes, headers, text parts, source, threads [7] |
| Search | yes, server-side `SEARCH` [inference from IMAP4rev1] | **no** — the envelope endpoints take only `limit`, `offset`, `min_received_at`, `max_received_at` [8] |
| Labels / categories / filters / autoreply / signatures | no [inference] | yes [7] |
| Send | yes (SMTP) | **no send endpoint exists** [7] |
| Create a draft | yes — `APPEND` to the Drafts folder [inference] | **no create-message endpoint exists**; `draft` appears only as a folder purpose [7][9] |
| Push / webhook | IMAP `IDLE` [3] | none documented [7] |

### Endpoints and ports

- IMAP: `imap.yandex.com:993` (SSL), or `imap.yandex.ru`; **`imap.ya.ru` if you are not in Russia** [1][2][4].
- SMTP: `smtp.yandex.com:465` (SSL), `587` when the client opens in the clear [1][2].
- POP3 exists (`pop.yandex.com:995`) and Yandex explicitly disclaims it: "We can't guarantee correct interaction
  … over a POP3 connection. The developers no longer work on updates for the POP3 protocol" [1].
- REST: `https://cloud-api.yandex.net/v1/mail/...` — the current host; `api360.yandex.net` is the deprecated one
  ("methods on it are no longer updated") [25].
- OAuth: `https://oauth.yandex.ru/authorize`, `https://oauth.yandex.ru/token` [10][11].
- All of it is outbound HTTPS/IMAPS/SMTPS on 443/993/465 — no other port, no callback listener.

### What the servers say about themselves

Yandex publishes the exchange in its own OAuth page [3], which is the closest thing to a capability statement:

```
* CAPABILITY IMAP4rev1 CHILDREN UNSELECT LITERAL+ NAMESPACE XLIST BINARY UIDPLUS ENABLE ID AUTH=PLAIN IDLE MOVE
250-8BITMIME  250-PIPELINING  250-SIZE 42991616  250-AUTH LOGIN PLAIN XOAUTH2  250-DSN  250-ENHANCEDSTATUSCODES
```

Three things worth extracting: **`IDLE` is advertised** (so a trigger face is possible at all), **`XOAUTH2` is
supported but deliberately not advertised** ("этот механизм не упоминается в выводе команды `CAPABILITY`, но
поддерживается" [3]), and **`SIZE 42991616`** — 41 MiB is the largest message the submission server will take [3].

### The object model

Folders are the only structure IMAP sees, and each has a system purpose (`inbox`, `sent`, `trash`, `spam`, `draft`
[9]). Labels (метки), categories (tabs), threads, filters, black/white sender lists, autoreply and signatures are
**REST objects with their own scopes** — `mail:labels.read`, `mail:tabs.read`, `mail:filters.write`,
`mail:autoreply.read`, `mail:signatures.write` and a dozen siblings [6].

**How labels appear over IMAP is not documented** — see Missing evidence. A container that lives on IMAP alone
`[inference]` sees folders and not labels, and the two are different objects in the web UI.

---

## 2. Auth: how a human grants the agent access, and what gets stored

There are two grant types and they are not equivalent. **This is the most consequential choice in the whole
integration.**

### Path A — app password (five minutes of clicking, no OAuth app, full mailbox)

1. In Yandex Mail: Settings → **Email clients** ("Почтовые программы") → enable
   *"С сервера imap.yandex.com по протоколу IMAP"* and *"Пароли приложений и OAuth-токены"*, save [1][2][23].
   Without both toggles, `AUTHENTICATE` fails with `[AUTHENTICATIONFAILED] … Invalid credentials or IMAP is
   disabled` [3].
2. In Yandex ID → **Security → Access to your data → App passwords**, pick the app type **Mail**, name it, click
   Next. The password is shown **once** ("You can see this created password only once") [15][16].
3. **It does not work yet.** "The password will become active in 2 to 3 hours" [16] — stated in both language
   versions [15][16]. Any test run in the first two hours fails with a credentials error that has nothing to do
   with the credentials.
4. Paste it into the container as `YANDEX_APP_PASSWORD`. Login = the local part for a personal mailbox
   (`username` for `username@yandex.com` [1]); for Yandex 360 for Business it must be the **full address** [2].

**What it grants.** Yandex's own framing is narrower than it looks: *"No app password grants access to your
account"* — and the example given is that a **Mail** password does not permit Disk over WebDAV [16]. So the
password is scoped to the *service*, and a Mail app password is the whole mailbox: read every message, send as
you, delete, change settings. There is no read-only app password and no per-folder scope. **An agent holding one
holds the mailbox.** [Direct evidence for the scoping; `[inference]` that no finer scope exists — the page lists
exactly five app types and none is a restricted mail type [15].]

**What invalidates it, silently and without warning to the container:** restoring account access, following "Log
out on all devices", and — per Yandex-adjacent guides, not the current help page — changing the account password
with 2FA off, or toggling 2FA [16][37 secondary]. Since 2023 the account password cannot be used in third-party
mail clients at all; app passwords and OAuth tokens are the only ways in [2][37 secondary].

### Path B — OAuth 2.0 + `XOAUTH2` (a real OAuth app, scoped, but the token is still pasted by hand)

1. Register an app at `https://oauth.yandex.ru/client/new/` as **"Для доступа к API или отладки"**. For that app
   type **`redirect_uri` is fixed to `https://oauth.yandex.ru/verification_code` and cannot be changed** [13] —
   which means, conveniently, *no redirect server is needed anywhere*.
2. In **Доступ к данным**, tick only what the integration needs. The mail scopes are per-surface and this is the
   only place a read-only grant exists [3][6]:

   | Scope | Unlocks |
   |---|---|
   | `mail:imap_ro` | read messages over IMAP, no delete [3] |
   | `mail:imap_full` | read and delete over IMAP [3] |
   | `mail:smtp` | send through `smtp.yandex.com` [3] |
   | `mail:messages.read` / `.write` | REST: read envelopes/headers/parts/source · mark, move, delete, spam [6] |
   | `mail:folders.*`, `mail:labels.*`, `mail:tabs.read`, `mail:counters.read`, `mail:filters.*`, `mail:senders.*`, `mail:autoreply.*`, `mail:signatures.*` | the rest of the REST surface [6] |

   `mail:imap_ro` + `mail:smtp` is the interesting pair: **read and send, but not delete** — strictly less than an
   app password grants, for the same mailbox.
3. As a human: open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>`, log in, click
   Allow, copy the token off the `#access_token=…` page. Yandex says it stores nothing you can retrieve later: *"Вы
   не сможете найти полученный токен в личном кабинете"* [12].
4. Paste it into the container. Optionally also the `refresh_token`, but the manual `response_type=token` flow
   returns only `access_token` and `expires_in` [12] — **a refresh token requires the `response_type=code` flow**,
   which needs a redirect receiver or a human who can copy `?code=` out of the address bar. `[inference]`

**Token lifetime.** Yandex distinguishes *renewable* tokens ("устаревает после нескольких месяцев, но продлевается
при каждой авторизации с этим токеном"; the app page shows the floor, "not less than 1 year") from *limited*
tokens that die at the scope's limit [10]. The refresh endpoint returns `access_token`, `refresh_token` and
`expires_in` in seconds, with the caveat that **the main token may not change on refresh**, and the explicit
recommendation: *"Рекомендуем обновлять долгоживущие токены раз в три месяца"* [11]. Refresh needs
`client_id` + `client_secret` (or Basic auth) — i.e. the container would hold the app secret too [11].

**Verification is optional.** An unverified Yandex ID account can create up to 5 OAuth apps; Госуслуги
verification buys trust, support and more apps, not access [14].

### Where the secret lives

Per `docs/adr/0003-integrations-are-services.md`: **the integration owns its upstream credential**; mason holds only
the MCP URL and the trigger secret. So the app password (or OAuth token + client secret) is an env var read from
`deploy/.env` into the container, never a mason config field — and, if it is a token that can be refreshed, the
refreshed value has to land on the container's own `/data` volume `0600`, not back in `deploy/.env`.

---

## 3. Limits, quotas, sizes — and what hits first

### Sending (the part that bites)

| Limit | Value | Source |
|---|---|---|
| Recipients per day via a mail program or SMTP | **300** (personal, ru help) / **500** ("a 24-hour total", en help) | [18][19] |
| Recipients in one message over SMTP | **35** | [19][20] |
| Recipients per day from the web UI | 1 000 (10 000 if the addressees are distribution lists, Yandex 360 for Business) | [18] |
| Recipients per day from the mobile app | 50 | [18] |
| Counting rule | "one email, for example, with 10 recipients, counts as 10 emails" — To, Cc and Bcc all count | [18] |
| What a block does | sending stops, receiving and login continue; **it lifts 24 h after the last attempt** — "иначе блокировка продлится еще на сутки" | [18] |

Two contradictions to hold open: the ru page says 300/day and the en page says 500/day for the same product
[18][19], and the en page's per-message cap (35, client/SMTP) disagrees with its own per-message site cap (50)
while the ru page corroborates 35 over SMTP [19][20]. **Design to the smaller numbers** `[inference]`.

The ceiling is not the quota, it is the classifier: *"Если система защиты от спама заподозрит массовую рассылку
шаблонных или однотипных писем, рекламы или коммерческих предложений, она может заблокировать отправку раньше,
чем вы достигнете максимального лимита"* [18]. Personal mailboxes are explicitly "not intended for … work
correspondence"; the security system may block sending on template-like mail or mail about "deals, contracts and
money transfers", and the decision is made by a neural network [18]. And the extension rule means **a retry loop
that keeps trying is not neutral — each attempt restarts the 24 hours** [18].

### Message sizes

- Inbound to a Yandex mailbox: **30 MB** max, else `552 Message size exceeds fixed limit` [21].
- SMTP submission: the server advertises `SIZE 42991616` — 41 MiB [3]; the web UI instead uploads anything over
  25 MB of attachments to Disk and mails links, with a 1 GB per-attachment ceiling [22]. `[inference]` A container
  speaking SMTP gets the 41 MiB ceiling and no Disk magic; anything it attaches over ~30 MB will bounce at the
  receiving Yandex mailbox anyway.

### The REST API

- Pagination is `limit` (**default 50, min 1, max 200**) + `offset`, plus `min_received_at`/`max_received_at`
  [8]. No cursor, no total count — 200 envelopes per round trip is the hard ceiling.
- `429 Too Many Requests` is a documented response with **no published rate** [9]. There is no rate-limit table
  anywhere in the Mail API docs `[inference from the complete index, 7]`.
- The 360 admin API adds: requests only as an organisation admin, at most 500 organisations per user [24].
- Error taxonomy is documented per endpoint and worth mapping rather than guessing: folder-limit refusal, `429`,
  `403` on a token missing a scope [9].

### What hits first, in order

1. **The SMTP classifier**, not the 300/day quota — an assistant that mails the same notification shape twice, or
   mails about money, is inside the danger zone from day one [18].
2. **The 24-hour block that a retry extends** — the same shape as Telegram's `429`, but with a much worse
   consequence for ignoring it [18].
3. **The read path is untroubled.** 200 envelopes a page is generous for a personal inbox, and IMAP `SEARCH` has no
   documented limit. A poller that reconnects instead of idling is the realistic way to annoy a mail server
   `[inference — no IMAP connection limit is documented anywhere]`.

---

## 4. Off-the-shelf MCP servers — all community, all small

**There is no official Yandex Mail MCP server.** Yandex does ship MCP servers, but for other products: Wiki
(`https://mcp.wiki.yandex.net`), Forms (`https://mcp.forms.yandex.net`), Tracker
(`https://mcp.tracker.yandex.net/mcp`), plus Yandex Cloud's toolkit/docs servers — each a hosted Streamable-HTTP
endpoint that forwards the caller's OAuth/IAM token and needs an `X-Org-Id` header [27][28][29]. None of those
pages mentions Mail, and every mail-shaped URL I probed under `yandex.ru/support/` is a 404.

Separately: **Yandex 360 announced an MCP server for the virtual office on 2026-10-08**, in preview, connectable by
any organisation — and the announcement's one concrete detail is the permission model: *"агент не сможет отправить
от имени человека письмо, он может лишь составить черновик"* [30 secondary, corroborated by 31 secondary]. I could
not find the primary documentation page or the endpoint URL. Treat as: real, but un-documented, org-scoped, and
deliberately unable to send.

The community field, read from GitHub metadata on 2026-10-26:

| Repo | Lang | License | Stars | Last commit | Tools | Verdict |
|---|---|---|---|---|---|---|
| [NextStat/yacli](https://github.com/NextStat/yacli) | Rust | MIT | 27 | 2026-03-15 (v0.5.5; 58 commits in the 3 days before) | mail + calendar + disk + account/auth, `prompts`, `resources`, MCP Apps; `mcp --transport http` | **The only one with depth**, and the only one that speaks HTTP rather than stdio. Silent for 7 months; pre-1.0 |
| [colibri11/yad](https://github.com/colibri11/yad) | TypeScript | MIT | 1 | 2026-06-15 (v1.4.1) | 7 mail + 5 calendar + 5 contacts + 9 disk; IMAP IDLE; HTTP/SOCKS proxy support | Most *aligned* with this use case (IDLE, proxy, app passwords, one binary for the three services), least *supported* |
| [gdigora/yandex-mail-mcp](https://github.com/gdigora/yandex-mail-mcp) | Python | **none** | 8 | 2025-12-22 (3 commits, one day) | ~7 (list/search/read/attachment/send/move/delete) | Dead, and **unlicensed — legally unusable** |
| [imdeniil/yandex-mail-mcp](https://github.com/imdeniil/yandex-mail-mcp) | Python | MIT | 0 | 2026-04-10 | 28 | A fork; one day of work; 0 stars |
| [nikarmontag-cmd/claude-yandex-mail](https://github.com/nikarmontag-cmd/claude-yandex-mail) | Python | MIT | 1 | 2026-04-26 | 11 + 3 skills | One day; Claude-plugin shaped |
| [medzhidov/openclaw-mail-bridge](https://github.com/medzhidov/openclaw-mail-bridge) | JS | MIT | 0 | 2026-03-29 | 5, read-only, SQLite archive | Interesting *shape* (read-only by construction), abandoned at v0.1.1 |
| [amalychev/mail-mcp](https://github.com/amalychev/mail-mcp) | TS | **none** | 1 | 2026-08-10 | 20, any IMAP provider, has a `yandex` preset, reads attachments as images | Freshest and best-scoped, but unlicensed and points at a hosted endpoint |
| [andrewmalov/mcp-imap](https://github.com/andrewmalov/mcp-imap) | Python | **none** | 0 | 2026-01-07 | 6 | Dead |

**Maintenance risk, stated plainly:** every one of these is one person's weekend, none has a test suite worth the
name that I could see from the metadata, and three carry no license at all (which makes vendoring them a legal
question, not a technical one). The pattern across all eight is *read, search, send* against IMAP/SMTP with an app
password — the same 800 lines, written eight times. **None of them is a tools face mason can adopt unmodified**,
because none is a Streamable-HTTP MCP server reachable by name on `mason-mcp` at `:8082/mcp` (yacli can be, and is
the only candidate for "wire it up and see") and none implements the trigger face at all.

---

## 5. What the mason integration would look like

Name: `mason-yandex-mail`. One package under `integrations/yandex-mail/`, its own `package.json`, tests and image;
mason knows `http://mason-yandex-mail:8082/mcp` and a trigger secret, and nothing else
(`docs/adr/0003-integrations-are-services.md`). One deliberate difference from `mason-telegram`: **that container
never speaks as the owner; this one does.** It sends mail from Denis's address to Denis's correspondents. That
single sentence drives every default below.

### Tools face — MCP over Streamable HTTP on `:8082/mcp`, stateless

Read-only by default; the two write tools exist but are off unless the env says otherwise.

| Tool | What it does |
|---|---|
| `list_folders()` | The folder tree with system purposes — `{name, delimiter, purpose, messages, unseen}` — so the agent can name a folder instead of being told `Отправленные`. |
| `unread_summary()` | Per-folder unseen counts in one call; the cheap "is there anything for me" probe. |
| `search(query, folder?, limit?, since?, before?)` | IMAP `SEARCH` with the server's own syntax (`FROM`, `SUBJECT`, `SINCE`, `UNSEEN`, `BODY`), returning envelopes with `uid`, `message_id`, `from`, `subject`, `date`; capped and paged by `uid`. |
| `read_message(uid, folder?)` | Headers plus the `text/plain` part, preferring it over `text/html`; never the whole MIME tree, never a base64 blob. |
| `list_attachments(uid, folder?)` | Names, MIME types and sizes of the parts — so the model can decide whether to ask for one. |
| `read_attachment(uid, part, folder?)` | One part, size-capped, returned as text or an image; refused above the cap rather than truncated. |
| `list_thread(uid, folder?)` | The `References`/`In-Reply-To` chain resolved to envelopes, oldest first. |
| `create_draft(to, subject, body, in_reply_to?, references?)` | `APPEND` to Drafts with the threading headers set, so a human sees a real draft in the web UI. **The default write.** |
| `send_message(to, subject, body, in_reply_to?, references?, attachments?)` | SMTP submission; returns the `Message-ID` it created. Refused when today's budget on `/data` is spent, when the recipient's domain is outside the allowlist, and when `SEND_MODE=draft`. |
| `mark_read(uid, folder?) · move_message(uid, folder)` | Off by default; present because a triage agent without them leaves every message unread. |

What must be **read-only by default**, and why: `search`/`read_*` are the tools an injected conversation will aim
first — an email body is attacker-controlled text that lands in the model's context. `send_message` is the one tool
whose misuse is irreversible and visible to third parties; `create_draft` is the same intent with a human in the
loop and should be the default for anything the agent initiates. `send` should additionally refuse Bcc-only
fan-out and count every recipient against the local budget the way Yandex counts them [18].

### Trigger face — IDLE into the event door, no inbound anything

Yandex has no webhook [7], so this is a poller, and the honest way to poll is `IDLE`:

- One connection selects `INBOX`, sends `IDLE`, and treats an untagged `EXISTS` as "something arrived", then
  `UID SEARCH UNSEEN` for the new UIDs. `IDLE` is advertised [3]; **no idle timeout and no connection cap is
  documented**, so `[inference]` re-issue `IDLE` every ~25 minutes and treat a dropped connection as normal.
- Fallback is a plain `UID SEARCH SINCE` every N minutes for the folders in `YANDEX_MAIL_FOLDERS`, because IDLE
  alone is one silent failure away from a trigger that never fires.
- One signed POST per message to `MASON_EVENT_URL` (`POST /api/events/yandex-mail`), `x-mason-signature:
  sha256=<hex hmac-sha256 of the raw body>`, same envelope as Telegram:

  ```json
  {"v":1,"id":"ym-8811-4711","kind":"mail.received",
   "payload":"Ilya <ilya@example.com> to me: Re: invoice — 2026-10-26 09:14, 1 attachment (PDF, 240 KB)"}
  ```

- `id` is `ym-<uidvalidity>-<uid>`. UIDVALIDITY makes a replayed batch after a crash the same event rather than a
  second one, and — unlike Telegram's monotonic update id — it also survives the mailbox being rebuilt: a changed
  UIDVALIDITY is a new id space, which is correct, because the UIDs really do mean different messages.
- **Bodies never cross the wire.** `payload` carries sender, subject, date and an attachment summary; the agent
  calls `read_message` when it decides it cares. That keeps a 2 000-character door cap from silently amputation a
  real message and keeps mail content out of the event log.
- Refusals handled exactly as `mason-telegram` documents: `400/401/404/405/413` advance past the message; `429`
  waits out `retry-after` up to a cap; an unreachable door retries the batch with backoff and does **not** advance.
- State on `/data`: `state.json` — per-folder `uidvalidity` and `last_uid`, plus `sent.json` holding today's
  recipient count and date, written temp-file-rename `0600`. A container whose volume has never held state reads
  the folder once, records the newest UID and starts from now — a restart must never replay last week's mail.

### Container shape

Node 22, TypeScript from source (`--experimental-strip-types`), no build step, `src` copied into the image — the
same shape as `integrations/telegram`. One process: the MCP HTTP server and the IDLE loop share the credentials and
the `/data` state. No published port; joins `mason-mcp` (so mason reaches it by name) and either `mason-edge` or
`mason-egress` + a proxy.

| Variable | Required | What it is |
|---|---|---|
| `YANDEX_LOGIN` | yes | The mailbox address; the full address is the login for 360 for Business, the local part for consumer mailboxes [1][2]. |
| `YANDEX_APP_PASSWORD` | one of | The Mail app password. Never logged, never in a payload [16]. |
| `YANDEX_OAUTH_TOKEN` | one of | Alternative grant; with `mail:imap_ro` + `mail:smtp` it is strictly less authority than an app password [3]. |
| `YANDEX_OAUTH_REFRESH_TOKEN` / `YANDEX_OAUTH_CLIENT_ID` / `YANDEX_OAUTH_CLIENT_SECRET` | no | Only if the code flow was used; the refreshed token lands in `/data` `0600` [11]. |
| `MASON_EVENT_URL` | yes | `http://mason:8787/api/events/yandex-mail` on the compose network. |
| `MASON_TRIGGER_SECRET` | yes | The HMAC key the door verifies; minted by `npm run integration -- secret yandex-mail --hook mail-received`. |
| `YANDEX_MAIL_SEND_MODE` | no | `draft` (default) or `send`; `draft` makes `send_message` refuse with a message the model can act on. |
| `YANDEX_MAIL_ALLOWED_RECIPIENTS` | no | Comma-separated domains `send_message` may reach; empty means "any address already in the mailbox's correspondence" `[inference — a cheap stand-in for an allowlist]`. |
| `YANDEX_MAIL_FOLDERS` | no | Folders the trigger watches; defaults to `INBOX`. |
| `YANDEX_MAIL_DAILY_RECIPIENTS` | no | Local budget, default **250** — under Yandex's 300, so the container stops before Yandex does [18]. |
| `HTTPS_PROXY` / `ALL_PROXY` | no | The VPN sidecar. Node's `fetch` ignores these, so mail protocol clients need `socks-proxy-agent`/`proxy-agent` wired explicitly — the same trap `integrations/telegram` documents for `undici`. |
| `DATA_DIR` / `PORT` | no | `/data`, `8082`. |

Volumes: one, `/data`. Networks: `mason-mcp` inbound, and — because a mail provider is reachable from most hosts
but not necessarily from a VPN-shaped egress — `mason-egress` + a proxy sidecar if the host's route to
`imap.yandex.com:993` is the sidecar's business.

### One container or three?

Mail, Calendar and Disk share a credential model and a vendor, and `yacli`/`yad` both ship them as one binary
[32][33]. ADR-0003's unit is "an integration is a service", and `[inference]` **three containers** is the right
reading: one unreachable upstream then costs one tool surface, not all of them, and `mason-edge` routing can differ
per service. The cost is three copies of the Yandex auth dance — which is the actual argument for the single
`yandex` container, and the reason to decide once, before the second one is written.

---

## 6. Risks, and the failure that would bite in a month

**Named failure: the mail the agent sends stops going out, and the container makes it worse.** The chain is
specific and short: the spam classifier decides the assistant's mail is template-like or business-like — a
notification, a reply about a contract — and blocks sending before any quota is reached [18]. Sending is the only
thing blocked; receiving still works, so `read_message` and the trigger keep succeeding and nothing in the event
stream looks wrong. Then the retry: the block *lifts 24 h after the last attempt* and each attempt restarts it
[18], so a container that retries a failed `send_message` with backoff — exactly what `mason-telegram` does for
`429`, and the pattern a reviewer will copy — converts a one-day throttle into a permanent one. The agent, seeing
`sent` succeed locally and no bounce, will not notice for days; a human notices when someone says "I never got it".
Mitigations that follow directly: a local recipient budget under Yandex's number, `draft` as the default write
mode, mapping Yandex's refusal strings to a `send_message` error the model can act on, and **never** auto-retrying
a send refusal.

The rest, in the order I would expect them:

- **Silent credential death.** An app password dies on "log out on all devices" or an account-recovery event, with
  no notification to the container and no change on Yandex's side that a health check can see [16]. The container
  must log a *distinguishable* auth failure and say so in `/api/integrations`, or the agent's tools just start
  erroring mid-conversation.
- **The 2–3 hour activation delay** turns every credential rotation into an afternoon of "is it broken?" [16]. This
  is a documentation problem, and it belongs in the README before it belongs in code.
- **Token expiry, at the year mark, not the month mark.** Yandex's floor is "not less than 1 year" for a renewable
  token, with advice to refresh quarterly [10][11]; without a refresh token the container simply stops one day
  `[inference]`. A month-two variant exists: the token is revoked the moment anyone clicks through *Access to your
  data* and removes the app [10].
- **The 360 paywall drifting.** The REST API is already 360-only [5], and a secondary source reports Yandex cut
  free IMAP/POP3/SMTP access for Yandex 360 for Business organisations from 2026-06-29 [36 secondary — not
  confirmed by any Yandex page I could fetch; the current help pages still document IMAP setup without a tariff
  note, 1][2]. `[inference]` If that logic ever reaches personal mailboxes, an IMAP-based integration stops working
  while the REST API keeps working — which argues for keeping the REST API as the read path where it is available.
- **Full-mailbox read is the security shape.** An app password grants read of every message in the mailbox:
  password resets, bank statements, 2FA codes, other people's confidences [16]. Those messages will pass through
  the model's context whenever the agent searches broadly, and `[inference]` the single most valuable control is
  not a scope (there isn't one) but a **folder scope in the container**: enumerate only the folders in
  `YANDEX_MAIL_FOLDERS` and refuse a `search` outside them. The OAuth path's `mail:imap_ro` is the only real
  read-only grant Yandex offers [3], and it is worth preferring for that reason alone.
- **Attachments as an injection surface.** Email is attacker-controlled input by definition; `read_attachment`
  returning a PDF's text into context is the same risk class as a web page. Cap it, and prefer "there is an
  attachment named X, 240 KB, PDF" to the content.
- **The unlicensed-MCP trap.** Three of the eight existing servers carry no license [33][34][35]; copying their
  MIME handling into `integrations/` would be the fastest route to a working tool and the wrong one.

## 7. Recommendation

**Build it, as a `medium` integration — bigger than `mason-telegram`, smaller than the tool machine.** Mail is the
one Yandex surface where a self-hosted agent has an unambiguous job (triage, draft, answer, file) and where the
protocol is boring and stable: IMAP `IDLE` and SMTP submission have not changed in twenty years, there is no
webhook to expose, no redirect URI to serve (Yandex fixes `redirect_uri` to `verification_code` for API apps
[13]), and no inbound port to open — the whole thing is two outbound TLS connections, which is exactly the fence
mason already has. The cost is the unglamorous half: MIME and charset decoding, `References` threading, Cyrillic
folder names in modified UTF-7, and an error taxonomy where "authentication failed" can mean four different things
[3]. That is why it is *medium*: `[inference]` roughly 1 200–1 800 lines of source plus tests, one process, one
volume, no new dependency on mason's side — the Telegram integration's shape with a protocol parser bolted on. The
two decisions that must be made before the first line: **OAuth `mail:imap_ro` + `mail:smtp` or an app password**
(scoped-but-pasted-token versus full-mailbox-but-click), and **`draft` or `send` as the default write** (my answer:
drafts, with `send` opt-in per deployment). The three first steps:

1. **Prove the credentials and the protocol by hand, before any container.** A throwaway script that logs in with a
   fresh Mail app password, lists folders, `IDLE`s for an hour, and sends one message to the same mailbox (expect
   the 2–3 hour activation delay [16], and start it the day before). Record the *exact* strings for: bad password,
   IMAP disabled, day-quota block, and spam-classifier refusal — those four strings are the container's whole error
   taxonomy, and none of them is documented verbatim [3][18].
2. **Ship the read-only tools and the trigger, and register nothing writable.** `list_folders`, `unread_summary`,
   `search`, `read_message`, `list_attachments`, `list_thread`, plus the IDLE poller with UIDVALIDITY-pinned ids;
   one `integrations.json` entry, `mail-received` hook, secret minted with `npm run integration -- secret`. Verify
   the dedupe id survives a container restart and that a fresh volume starts from "now" rather than replaying the
   inbox.
3. **Then add the writes, cheapest first.** `create_draft` (`APPEND` to Drafts with `In-Reply-To`/`References`) and
   prove it appears in the web UI threaded; only after that `send_message` behind the local daily budget, the
   recipient-domain allowlist and `draft` as the default — and test the classifier deliberately (send the same body
   twice) so the refusal path is exercised before a correspondent exercises it.

---

## Contradictions

- **Daily send quota.** 300/day over SMTP (ru help) versus 500/day "24-hour total" (en help) for the same consumer
  product [18][19]. Unresolved; the container should budget to the lower number.
- **Recipients per message.** 35 over SMTP (corroborated by two pages [19][20]) versus 50 from the web UI [19]; the
  business variant adds 10 000/day for distribution-list addressees [18].
- **App passwords and 2FA.** The current Yandex ID page states no 2FA requirement at all [15][16]; older
  Yandex-adjacent guides state that 2FA must be on to create one [37 secondary]. Unresolved — and it matters,
  because it changes the setup script a human follows.
- **Whether IMAP is still free.** Yandex's current client-setup pages assume IMAP with an app password and mention
  no tariff [1][2]; a secondary source reports free IMAP/POP3/SMTP was withdrawn for Yandex 360 for Business
  organisations on 2026-06-29 [36 secondary]. No Yandex page I fetched confirms the withdrawal.
- **The official 360 MCP server.** Announced 2026-10-08 as preview, draft-only, org-scoped [30][31 secondary]; no
  primary documentation page or endpoint URL exists that I could find, while Wiki/Forms/Tracker each have one
  [27][28][29].

## Missing evidence

- **How labels look over IMAP.** The REST API treats labels as objects with their own scope [6]; nothing documents
  whether IMAP sees them as folders, keywords, or not at all. A container that plans to use labels needs a live
  mailbox to answer this.
- **IMAP connection limits, IDLE timeout, and per-folder message caps** are not documented anywhere I could reach.
  The `IDLE` capability is confirmed [3]; its operational envelope is not.
- **The Mail REST API's actual rate limit** — `429` exists [9], no number is published.
- **Whether a personal (non-360) mailbox can use the REST API at all** with a valid token; the doc says 360
  subscribers only [5] and gives no error for the other case.
- **Datacenter / foreign IP behaviour.** Nothing states a policy. The nearest primary evidence is the *suspicious
  account* heuristic, which blames a missing "secure phone number" [19], and the `imap.ya.ru` alias "if you're not
  in Russia" [1] — which implies foreign access is expected, not blocked. Whether a VPN-sidecar exit IP trips a
  challenge is untested; `[inference]` a residential-looking exit is safer than a known cloud range, and a phone
  bound to the account is the documented mitigation for a flagged account [19].
- **Whether an app password can be created on an account with no bound phone** — not stated on the app-password
  page [15]; the phone page only describes binding [17].
- **Send-side `XOAUTH2` refresh after an hour** — whether a long-running IMAP `IDLE` connection survives an access
  token refresh, or must be re-authenticated, is undocumented.

## Sources

- [1] Other mail clients — Yandex Mail (https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others) — the IMAP/SMTP settings, the app-password step, `imap.ya.ru` for outside Russia, and the "don't use your provider's SMTP" warning.
- [2] Другие программы — Почта, Яндекс 360 для бизнеса (https://yandex.ru/support/yandex-360/business/mail/ru/mail-clients/others) — the same procedure in ru, the "Пароли приложений и OAuth-токены" toggle, full-address login for 360.
- [3] OAuth-авторизация в Яндекс Почте (https://yandex.ru/support/yandex-360/business/mail/ru/web/security/oauth) — **the single most useful page**: scopes `mail:smtp`/`mail:imap_ro`/`mail:imap_full`, the `XOAUTH2` argument format, the `CAPABILITY` and `EHLO` transcripts (`IDLE`, `SIZE 42991616`), and the `AUTHENTICATIONFAILED … IMAP is disabled` error.
- [4] Шифрование передаваемых данных — Почта (https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/ssl) — ports 993/995/465.
- [5] API Яндекс Почты — о сервисе (https://yandex.ru/dev/yandex-360/mail/ru/) — the REST API's capabilities and the 360-tariff restriction.
- [6] Доступ к API — API Яндекс Почты (https://yandex.ru/dev/yandex-360/mail/ru/access.md) — the full `mail:*` scope list, the `Authorization: OAuth` header, and the manual token URL.
- [7] API Яндекс Почты — complete documentation index (https://yandex.ru/dev/yandex-360/mail/ru/llms.txt) — all 60-odd endpoints; the absence of any send/draft-create/webhook is the evidence, read off the whole surface.
- [8] Получение конвертов из указанной папки (https://yandex.ru/dev/yandex-360/mail/ru/api/folders/get-envelopes.md) — `limit` default 50 / max 200, `offset`, `min_received_at`/`max_received_at`; i.e. the pagination contract.
- [9] API Яндекс Почты — full reference in one file (https://yandex.ru/dev/yandex-360/mail/ru/llms-full.txt) — the `429 Too Many Requests` response, the folder-limit refusal, the `draft` system folder purpose.
- [10] Реализация OAuth в Яндексе (https://yandex.ru/dev/id/doc/ru/concepts/ya-oauth-intro.md) — renewable vs limited tokens, the "not less than 1 year" floor, how a user revokes.
- [11] Обновление токена (https://yandex.ru/dev/id/doc/ru/tokens/refresh-client.md) — the refresh request, `expires_in`, "the main token may not change", refresh quarterly.
- [12] Получение токена вручную (https://yandex.ru/dev/id/doc/ru/tokens/debug-token.md) — `response_type=token`, the `#access_token=…` redirect, "tokens are not stored where you can find them".
- [13] Регистрация приложения для доступа к API (https://yandex.ru/dev/id/doc/ru/register-api.md) — API apps, and `redirect_uri` fixed to `https://oauth.yandex.ru/verification_code`.
- [14] Верификация сервиса (https://yandex.ru/dev/id/doc/ru/confirm-account.md) — verification is optional; 5 apps unverified.
- [15] Пароли приложений — Яндекс ID (https://yandex.ru/support/id/authorization/app-passwords.html) — the five app types, "no app password grants access to your account", the 2–3 hour activation.
- [16] App passwords — Yandex ID (https://yandex.com/support/id/authorization/app-passwords.html) — the English wording of the same, plus what resets them.
- [17] Привязка телефонных номеров — Яндекс ID (https://yandex.ru/support/id/authorization/phone.html) — how a phone is bound and what it is used for.
- [18] Отправить много писем — Почта (https://yandex.ru/support/yandex-360/customers/mail/ru/web/letter/create/send-many-letters) — the 300/1 000/50 daily table, the per-recipient counting rule, the 24 h block and its extension, and the spam-classifier clause.
- [19] I can't send emails — Yandex Mail (https://yandex.com/support/yandex-360/customers/mail/en/web/letter/create/troubleshooting) — the 500/day and 35-per-message figures, and the "suspicious account … secure phone number" heuristic.
- [20] Написать письмо — Почта (https://yandex.ru/support/yandex-360/customers/mail/ru/web/letter/create/write-letter) — 50 recipients from the site, 35 from a mail program.
- [21] Слишком большой размер вложения (https://yandex.ru/support/yandex-360/customers/mail/ru/bounces/yandex/message-size-exceeds-fixed-limit) — the 30 MB inbound cap and the bounce text.
- [22] Вложения — Почта (https://yandex.ru/support/yandex-360/customers/mail/ru/web/letter/attachments) — 25 MB auto-Disk, 1 GB per attachment, 10 GB from Disk.
- [23] Решение проблем с почтовой программой (https://yandex.ru/support/yandex-360/business/mail/ru/mail-clients/mail-clients-troubleshooting) — the two required toggles, restated as the fix for a failing app password.
- [24] Ограничения — API Яндекс 360 (https://yandex.ru/dev/api360/doc/ru/limits.md) — organisation-admin only, 500 organisations per user; and, by absence, no published request rate.
- [25] Доступ к API — Яндекс 360 (https://yandex.ru/dev/api360/doc/ru/access) — `cloud-api.yandex.net` is current, `api360.yandex.net` frozen.
- [25b] Тарифы Яндекс 360 для бизнеса (https://360.yandex.ru/business/tariff/) — from 319 ₽/user/month for "Минимальный", 549 ₽ for "Основной"; i.e. the REST API's precondition is a subscription.
- [27] MCP-сервер Яндекс Вики (https://yandex.ru/support/wiki/ru/mcp) — what an *official* Yandex MCP server looks like: hosted Streamable HTTP, `Authorization: OAuth …`, `X-Org-Id`.
- [28] MCP-сервер Яндекс Форм (https://yandex.ru/support/forms/ru/mcp) — the same pattern, another service.
- [29] Tracker MCP server (https://yandex.ru/support/tracker/en/user/mcp-server) — the same pattern in English, with the `Accept: application/json, text/event-stream` requirement.
- [30] «Яндекс 360» открыл доступ к сервисам для внешних ИИ-агентов — Новости Mail (https://news.mail.ru/economics/72643516/) — secondary, 2026-10-08: the 360 MCP server in preview, and "агент не сможет отправить … письмо, он может лишь составить черновик".
- [31] «Яндекс 360» открыл сервисы для внешних ИИ-агентов через MCP (https://www1.ru/news/2026/10/08/iandeks-360-otkryl-servisy-dlia-vnesnix-ii-agentov-cerez-mcp.html) — secondary, the same announcement.
- [32] NextStat/yacli (https://github.com/NextStat/yacli) — MIT, 27★, 58 commits 2026-03-12→15, v0.5.5, Rust, `mcp --transport http`, mail+calendar+disk.
- [33] colibri11/yad (https://github.com/colibri11/yad) — MIT, 1★, last commit 2026-06-15 (v1.4.1), TypeScript, 7 mail tools, IMAP IDLE, proxy support, app passwords.
- [34] gdigora/yandex-mail-mcp (https://github.com/gdigora/yandex-mail-mcp) — **no license**, 8★, 3 commits on 2025-12-22.
- [35] imdeniil/yandex-mail-mcp (https://github.com/imdeniil/yandex-mail-mcp) · nikarmontag-cmd/claude-yandex-mail (https://github.com/nikarmontag-cmd/claude-yandex-mail) · medzhidov/openclaw-mail-bridge (https://github.com/medzhidov/openclaw-mail-bridge) · amalychev/mail-mcp (https://github.com/amalychev/mail-mcp) · andrewmalov/mcp-imap (https://github.com/andrewmalov/mcp-imap) — the rest of the field: 0–1★, one-day-or-one-month projects, two of the five unlicensed.
- [37] Third-party setup guides read for one claim only — Лайфхакер on the 2023 end of account-password auth (https://lifehacker.ru/yandeks-otklyuchaet-vxod-po-parolyu/), Финтех.com on what resets an app password (https://xn--e1afpuhk.com/sozdat-paroli-prilozhenij-yandex-id/), Кулябов on 2FA and app passwords (https://yamadharma.github.io/ru/blog/2021/11/01/mail-yandex-application-passwords/), UIS on the same (https://www.uiscom.ru/academiya/spravochnyj-centr/emeyltreking/kak-sozdat-parol-dlya-prilozheniya/) — secondary, 2021–2023, and used only where Yandex's current pages are silent.
- [36] itforprof — alternatives to Яндекс 360 (https://itforprof.com/pochta/alternativy-yandeks-360-dlya-biznesa-v-2026/) — secondary, 2026-03-07: the claim that free IMAP/POP3/SMTP ended for 360 business organisations on 2026-06-29. Used only as the flag on a contradiction.

Rejected/deprioritised: the many Yandex help pages for individual mail clients (Outlook, Thunderbird, The Bat!, Apple
Mail) — same facts, restated per client; `rusender.ru` and `gradly.ru` limit round-ups — secondary and derivative of
[18]; `skillfoxx.ru` pages describing `yad`/`yacli` — marketing for repos I read directly; the Хабр Q&A thread on
`php_imap` and `alpineapp.email`'s XOAUTH2 note — useful corroboration that `XOAUTH2` works in practice, but
third-party and not needed once [3] exists; `yandex.ru/dev/mail/` (404) and `yandex.ru/dev/mail360/` (404) —
dead paths worth recording so nobody re-probes them.

## Next steps

1. **Read one live mailbox.** A single `openssl s_client -connect imap.yandex.com:993` session with a real app
   password settles three of the open questions at once: whether labels appear as folders or keywords, what
   `CAPABILITY` says today, and how long an `IDLE` survives.
2. **Find the primary docs for the 360 MCP server.** If Yandex publishes a hosted mail MCP endpoint with drafts and
   no send, the whole container's write surface changes shape — it becomes a thin trigger plus a hosted tools face,
   and the size estimate drops from medium to small.
3. **Ask Yandex's own rate limits of the API, not the docs.** Fifty sequential envelope reads against a 360 mailbox
   will find the `429` threshold far faster than another search will.
