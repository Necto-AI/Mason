# Yandex Disk — a REST file API behind one OAuth token, and what a mason container would do with it

> Research note, 2026-10-26. Yandex Disk is a consumer file store with one flat REST API (`cloud-api.yandex.net/v1/`), a
> single long-lived OAuth token per app-and-user, no server-side search, no push and no webhooks — so an integration is a
> metadata client plus a poller, not a subscriber. 45 sources: Yandex's own API reference (read as the `.md` source of
> the docs site), the Yandex ID OAuth reference, the API terms of use, Yandex 360's help pages for upload sizes and
> quotas, and the source of six MCP servers, two SDKs and one sync client at a pinned commit. One live probe of the API
> from this host is recorded inline and marked as such.
> Written for docs/research/yandex-integrations/. Facts carry a source; [inference] marks reasoning, not evidence.

## 1. What the API is (transport, auth, objects)

- **One host, one version, one method family.** Every call is `https://cloud-api.yandex.net/v1/...` — "Each request must
  include the version of the Yandex Disk API", and the only version is `v1` [2]. The docs' own change history has not
  been touched since **2015-12-16** and states "The current REST version of the Yandex Disk API is Version 1. The API is
  fully backward-compatible" [22]. It is JSON only: "the Yandex Disk API only supports the `application/json` MIME type"
  [2].
- **Auth is one header, no OAuth dance per call**: `Authorization: OAuth <token>` — the literal word `OAuth`, a space,
  then the token [2]. A maintained client sends exactly that (`Authorization: OAuth ${token}` in
  `yandex-disk-mcp/src/index.ts`, line 46) [36], and rclone stores `token_type: "OAuth"` [43].
- **Live probe from this host (datacenter IP, 2026-10-26):** `GET /v1/disk/` with no token answers
  `HTTP/1.1 401`, `Content-Type: application/json`, body
  `{"error":"UnauthorizedError","description":"Unauthorized","message":"Не авторизован."}`, with a
  `Yandex-Cloud-Request-ID` header and an internal service name `disk-api-stable-extapi` in it. Same answer for a bogus
  token. No captcha, no region block, no HTML.
- **The objects are three nouns and one escape hatch.**
  - *Disk* — capacity and system folders: `GET /v1/disk/` returns `trash_size`, `total_space`, `used_space`,
    `system_folders.applications`, `system_folders.downloads` [7].
  - *Resource* — a file or folder, identified by `path`, carrying `name`, `type`, `size`, `created`, `modified`, `md5`,
    `mime_type`, `public_url`, `public_key`, `custom_properties`, and for folders an `_embedded` page of children with
    its own `limit` / `offset` / `total` [8][9].
  - *Link* — the `{href, method, templated}` object returned by upload and download requests, plus an
    `operation_id` on upload [4]. `templated: true` means the URL is an RFC 6570 template to fill in before use [4].
  - *Operation* — `GET /v1/disk/operations/{id}` returning `status` of `success` / `failed` / `in-progress`, used for
    everything that is not instantaneous: upload-by-URL, copy, move, trash restore, trash empty [5][16][17][20].
- **The `path` namespace.** Paths are `disk:/foo`, `trash:/cat.png`, `app:/`, or a bare `/foo` — "the `disk:/foo` and
  `/foo` paths refer to the same folder" [2]. Trash paths are "relative to the Trash root directory" and are rendered
  back as `trash:/...` in responses [9][16]; a deleted resource may carry a uniqueness suffix, e.g.
  `trash:/foo_1408546879`, "С помощью этого идентификатора ресурс можно отличить от других удаленных ресурсов с тем же
  именем" [9]. Every Trash response also carries `origin_path` (`disk:/foo/cat.png`), which is what a restore needs [9].
- **`app:/` is the app's own folder, and it is the agent's scratch space only by courtesy.** An app registered with
  **Access to app folder in Yandex Disk** (`cloud_api:disk.app_folder`) gets `app:/`, auto-created "on the first request
  with the appropriate OAuth token", named after the app, with the app ID appended on a name collision, inside the
  system *Applications* directory (`Приложения` for a Russian-language account) [3]. Three consequences, all documented:
  "If the app doesn't have permission for general access to Yandex Disk, it can only work with files in its own folder"
  [3]; **responses never say `app:/`** — a file written to `app:/photo.png` comes back as
  `disk:/Apps/Foo/photo.png` [3], so the container has to normalise paths on the way in and never trust the way out; and
  "Users have full access to files in the **Apps** folder, which means they can delete, move, and rename them" [3].
- **Endpoint inventory that matters for a tools face** (all confirmed in the reference):

  | Purpose | Call |
  |---|---|
  | Capacity | `GET /v1/disk/` [7] |
  | Metadata / one page of a folder | `GET /v1/disk/resources?path=&limit=&offset=&sort=&fields=&preview_size=` [8] |
  | Flat list of every file | `GET /v1/disk/resources/files?limit=&offset=&media_type=` [10] |
  | Recently uploaded | `GET /v1/disk/resources/last-uploaded?limit=&media_type=` [11] |
  | Create folder | `PUT /v1/disk/resources?path=` [12] |
  | Copy / move | `POST /v1/disk/resources/copy?from=&path=&overwrite=`, `POST /v1/disk/resources/move?...` [13][14] |
  | Delete (to Trash, or `permanently=true`) | `DELETE /v1/disk/resources?path=&permanently=` [15] |
  | Upload: get a URL, then PUT the bytes | `GET /v1/disk/resources/upload?path=&overwrite=` → `PUT {href}` [4] |
  | Upload by URL (Disk fetches it) | `POST /v1/disk/resources/upload?url=&path=&disable_redirects=` → `202` + operation [5] |
  | Download: get a URL, then GET the bytes | `GET /v1/disk/resources/download?path=` → `GET {href}` [6] |
  | Publish / unpublish | `PUT /v1/disk/resources/publish?path=`, `PUT /v1/disk/resources/unpublish?path=` [18][19] |
  | Trash: list / restore / empty | `GET /v1/disk/trash/resources`, `PUT /v1/disk/trash/resources/restore?path=&name=&overwrite=`, `DELETE /v1/disk/trash/resources?path=` [9][16][17] |
  | Operation status | `GET /v1/disk/operations/{id}` [20] |

- **There is no search endpoint.** The v1 reference has a *flat list* (`/resources/files` — "a flat list of all files on
  Yandex Disk in alphabetical order", filterable by `media_type` only) [10] and *recently uploaded* [11], and nothing
  that takes a query string. A `search` tool therefore means paging the whole Disk and filtering in the container
  [inference from the reference's contents]. The one MCP server that advertises search calls `client.search(...)` — a
  method that does not exist in the `yadisk` library it pins (see §4).
- **Pagination is limit/offset, and the default is 20**: "The default value is 20" for `limit`, with `sort` on
  `name`/`path`/`created`/`modified`/`size` and a `-` prefix for descending [21]. No maximum `limit` is documented
  anywhere in the reference [21][8] — clients cap it themselves (100 in one MCP server) [35][inference].
- **Two-step transfers are the whole model, and the second step is unauthenticated.** "Send the file to the upload URL
  using the PUT method within 30 minutes of getting the URL… You don't need an OAuth token to upload files to the
  storage" [4]. The download `href` is likewise a pre-signed URL whose "lifetime is limited" — with no number given [6].
  This is the single most useful property for a container behind a fence: **the credential mints short-lived, token-free
  capability URLs, and the bytes move over a different host**.
- **Upload by URL is a server-side fetch**: Disk downloads the file itself and reports `202` with an operation link;
  "If an error occurs, Yandex Disk doesn't try to download the file again", and the fallback the docs recommend is
  downloading it yourself and uploading it with the ordinary two-step path [5]. `disable_redirects` decides whether Disk
  follows a redirect [5].
- **Deleting to Trash does not free space**, and the docs say so twice: "перемещение ресурсов в корзину никак не влияет
  на доступное место на Диске. Чтобы освободить место, следует также удалять ресурсы из корзины" [15]. `trash_size`
  in the capacity object is how you see it [7].

## 2. Auth: exactly how a human grants the agent access, step by step, and what is stored where

**The shapes that exist.** Yandex ID has two app types and they are not interchangeable: "Determine your app type before
registering. You cannot change the type after registration" [29]. An *authorization* app (for third-party login) "can be
granted no more than three permission groups"; an *API access* app "interact[s] exclusively with developer data" and has
"no limit on the number of scopes" [29]. A headless agent acting for its owner is the second kind, and the registration
path for it is short: **Create app → "For API access or debugging" → name, contact email, permissions → Create** [28].
Two documented consequences of that choice: **the `redirect_uri` cannot be edited** and is pinned to
`https://oauth.yandex.ru/verification_code` [28] — a Yandex-hosted page that prints the token, not a listener on our
host — and the app is not exposed to other users' data at all [29].

**Scopes.** There are exactly four for Disk, and they are one group (`cloud_api`), not the `read:cloud` shape one might
expect from other vendors [2]:

| Scope | Grants |
|---|---|
| `cloud_api:disk.read` | "Read all of Yandex.Disk" [2] |
| `cloud_api:disk.write` | "Write anywhere on Yandex Disk" [2] |
| `cloud_api:disk.app_folder` | "Access the app folder on Yandex Disk" — `app:/` and nothing else [2][3] |
| `cloud_api:disk.info` | "Access information about Yandex Disk" — the capacity call [2] |

A minimal agent gets `cloud_api:disk.read` + `cloud_api:disk.write` + `cloud_api:disk.info`; a cautious one gets
`cloud_api:disk.app_folder` + `cloud_api:disk.info` and is then physically unable to touch the human's own files [3].
[inference] The two sets cannot be mixed usefully: `app_folder` alone is a sandbox, the broad pair is the whole Disk,
and there is no per-folder scope.

**The three ways a human hands over a token** — all documented, and only the third needs no browser on the agent's
machine:

1. **Debug token (paste).** Put `https://oauth.yandex.ru/verification_code` in the app's Redirect URI field, then open
   `https://oauth.yandex.com/authorize?response_type=token&client_id=<id>` in any browser, log in to the *target*
   account, press Allow, and read the token out of the URL fragment:
   `…/verification_code#access_token=<token>&expires_in=<seconds>` [26][2]. Nothing listens, nothing redirects to us; it
   is a copy-paste. The docs call it "meant for apps at the development or testing stage" [26] — the limitation is
   social, not technical [inference].
2. **Confirmation code + token exchange.** The code arrives in the redirect URL, which for an API-access app is Yandex's
   own verification page — so it is a copy-paste of a *code* instead of a token, then
   `POST https://oauth.yandex.com/token` with `grant_type=authorization_code` **plus client_id and client_secret**
   [25][29]. Strictly worse for us than (1) unless we want the refresh token [inference].
3. **Device code (no browser on the host at all).** `POST https://oauth.yandex.com/device/code` with `client_id` (and
   optional `scope`, `device_id`, `device_name`) returns
   `{"device_code","user_code","verification_url":"https://oauth.yandex.com/device","interval":5,"expires_in":300}`; the
   human opens that page **in their own browser anywhere** and types the `user_code`, while the container polls
   `POST /token` with `grant_type=device_code&code=<device_code>` (+ `client_id`, `client_secret` — both listed as
   optional in the request format) at the given `interval` [27]. The code lives **10 minutes** [27]. This is the only
   flow that fits a container with no browser [inference: the human's browser is the only place the consent page is
   opened, so the container's own address never touches it]. **Unverified:** the docs frame the device flow for
   "devices (such as TVs)" and say nothing about whether an *API access* app may use it; the request format does not
   require a platform [27][28].

**Lifetime, refresh, and revocation.** "Renewable token: expires after a few months, but is renewed every time you log
in with this token. When registering the app, the minimum lifetime is displayed, such as *at least 1 year*" [24]. The
refresh token "ha[s] the same lifetime" as the access token [25]. Refreshing is a plain
`POST https://oauth.yandex.com/token` with `grant_type=refresh_token&refresh_token=…` (+ client credentials), returning
a new `access_token` **and a new `refresh_token`** and `expires_in` in seconds [25]. Two documented wrinkles: "the main
token may not change when you update it… We recommend updating long-lived tokens every three months" [25], and the
response's `expires_in` was `124234123534` in the docs' own example — ~3 940 years [25], which is either a placeholder
or a reminder that the printed number should never be trusted as an absolute date [inference].

Tokens die on their own schedule, and every one of these paths is documented [30]: the user revokes the app on
`id.yandex.com/personal/data-access`; the user **changes their password**, **turns 2FA on or off**, recovers their
account, or uses "log out everywhere" — each of which revokes *every* OAuth and refresh token ever issued for the
account; and "the app owner changed the requested permissions or deleted the app", which revokes **all tokens ever issued
to that app** [30]. Also: an app may hold at most **30 device-linked tokens per user**, and issuing a new one silently
kills the oldest [30][27].

**What is stored where, for a mason integration.** The ADR is explicit that "the integration owns its upstream
credential… mason holds only the MCP URL and that integration's trigger secret"
(`docs/adr/0003-integrations-are-services.md`). So:

- In `deploy/.env` (0600, the operator's file): `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, and the seed
  `YANDEX_REFRESH_TOKEN` — this is what makes the container recoverable after a volume loss [inference].
- On the container's own volume, `/data/token.json` (0600, written whole — temp file, rename, exactly the telegram
  container's offset discipline): the current `access_token`, its `expires_in`-derived expiry **as an absolute
  timestamp**, and the newest `refresh_token`.
- Never: the token in a log line, in an MCP response, in an event payload, or in mason's `integrations.json` [ADR-0003;
  inference on the last three].
- In mason's `service/integrations.json`: the URL `http://mason-yandex-disk:8082/mcp`, one `description`, and the trigger
  secret — nothing about Yandex.

**The account itself is phone-bound.** Yandex ID registration is "По номеру телефона" — by phone number [34] — and the
app-registration page warns to "Make sure you can complete the verification process with this account" [28]. [inference]
There is no way to have a Yandex account, and therefore a Disk, and therefore this integration, without a phone number
attached to it; that is a fact about the account, not about the container.

## 3. Rate limits, quotas, sizes, and what hits them first

- **The only numeric request limit is in the terms of use, not the API docs: 40 requests per second.** "При превышении
  максимального количества обращений к Сервису - 40 (сорок) запросов в секунду предоставление Сервиса может быть
  ограничено или прекращено" — exceeding 40 rps can get the service limited or *terminated* [23]. The API reference
  itself only ever says `429` — "Слишком много запросов" — and never a number, on any endpoint [4][6][9][15][16].
  [inference] 40 rps is ~144 000 requests an hour; a single agent will not reach it, and the interesting reading is the
  second clause: sustained abuse is a contractual breach, not just a backoff.
- **Practical rate behaviour is undocumented and users hit it.** The rclone backend carries a pacer with `minSleep`
  10 ms / `maxSleep` 2 s and retries `429, 500, 502, 503, 504, 509` for Yandex specifically (`backend/yandex/yandex.go`,
  lines 39–41 and 188–190, read at
  https://raw.githubusercontent.com/rclone/rclone/master/backend/yandex/yandex.go) [43]. For WebDAV (the other
  door) there is a year of public 429 reports from a sync client, including a Yandex support reply that the API "is not
  supported" [rejected as evidence — a support transcript, not documentation; noted only because it is the only trace of
  a throttling policy with no published numbers].
- **Size of one file: 1 GB without a plan, 50 GB with any Yandex 360 plan — and the top tier says 100 GB.** The API's
  `413` is defined by reference to the consumer help rather than a number: "Максимальный размер одного файла для
  загрузки на Диск зависит от тарифа" [45]. The help page gives the numbers: "Without a Yandex 360 plan — 1 GB", "With
  any Yandex 360 plan — 50 GB", "You can't upload a file larger than 50 GB" [31]; the Russian page of the same article
  adds "С тарифами Яндекс 360 Для профи — 100 ГБ" [32]. Contradiction recorded in §Contradictions.
  **No 10 GB and no 350 MB figure exists in any current Yandex document I read** — not in the upload reference [4][45],
  not in the upload-by-URL reference [5], not in the help pages [31][32]. The only trace of anything chunked is one
  error code: "`412 Precondition Failed` — Wrong range was passed in the `Content-Range` header when uploading the file"
  [4], i.e. resumable uploads exist on the uploader but are not documented; the only client that used them is the
  official Java SDK, which has not been touched since **2015-09-22** [42]. [inference] The 10 GB/350 MB pair is either
  from a pre-2022 revision of these docs that is no longer in force (Wayback has no snapshot of the old upload pages at
  the URL forms I tried) or a conflation with another service; an integration must be built against 1 GB / 50 GB.
- **A monthly upload cap that is easy to miss and hits a working agent first.** "В течение месяца вы можете загрузить на
  Диск ограниченный объем файлов: не более двух объемов Диска в тарифах «Для себя» или «Для семьи»; не более трех
  объемов Диска в тарифах «Для профи»… Через 30 дней с момента первой загрузки лимит обновится" [33]. A free
  Disk is **5 GB** [33], so the free floor is **~10 GB of uploads per rolling 30 days**, after which "будет действовать
  ограничение на загрузку" — uploads stop, reads and downloads continue [33]. The API surfaces this as `423 Locked`
  with `UPLOAD_TRAFFIC_LIMIT_EXCEEDED` [45], on the *same* status code as "site is under maintenance" [45].
- **Storage quota is the second cliff**: `403` "Ваши файлы занимают больше места, чем у вас есть" on writes and `507`
  "Недостаточно свободного места" on the uploader [45][4]. Trash counts: `total_space`, `used_space`, `trash_size` are
  separate numbers and emptying Trash is the only way to move the first two [7][15].
- **Other per-request ceilings**: file name 255 characters, full path 32 760 characters [4]; `limit` default 20 and no
  documented maximum [21]; preview sizes S→XXXL (150→1280 px) or exact `120x240` [21].
- **Two asynchronous behaviours that look like bugs.** Uploading a file is not finished when the PUT returns: the
  uploader may answer `202 Accepted`, "the file has been received by the server but hasn't been moved to Yandex Disk
  yet" [4], and rclone documents the practical shape — Yandex "finalizes uploads asynchronously… can report an upload as
  complete slightly before the file is ready, so accessing the file's metadata too soon causes these [500] errors", with
  Yandex support recommending "waiting 1.5s - 3s after each upload" [43]. And for "very large files (bigger than about
  5 GiB)" Yandex "pauses (perhaps to calculate the MD5SUM for the entire file) before returning confirmation", long
  enough that rclone's default 5-minute timeout fires [43]. [inference] Any tool that uploads then immediately renames
  (as one MCP server does, "the tool waits for Yandex.Disk to process the file (up to 60 s…)") has discovered this the
  hard way [36].
- **What hits first, in order, for an always-on agent** [inference, from the numbers above]: (1) the monthly upload
  volume, on the 5 GB free tier, if the agent stores anything bulky; (2) token revocation by a password change or a 2FA
  toggle, because it is silent and instant [30]; (3) the 30-day Trash accumulating against `total_space` so that writes
  start failing `507` while the human sees free space in the web UI [7][15]; (4) request rate, which a single agent will
  not reach at 40 rps [23]; (5) per-file size, which only matters if the agent is asked to move something big [31].

## 4. Off-the-shelf MCP servers and clients, with license and maintenance assessment

**There is no official Yandex MCP server for Disk.** Yandex ships a family of official MCP servers — `toolkit`, `docs`,
`search`, `functions`, `containers`, `triggers`, `workflows`, `apigateway`, `mcpgateway`, `datacatalog-consumer` — for
**Yandex Cloud**, authenticated by a Cloud IAM token (max lifespan 12 hours), and none of them touches Disk [44]. The
consumer services (Disk, Mail, Calendar) have no vendor MCP at all [inference from the same page].

Six community servers exist, all MIT, all small, none with an organisation behind it. Measured 2026-10-26 from the GitHub
API and the published registries:

| Repo | Lang | ★ | Last commit | Transport | Tools | Assessment |
|---|---|---|---|---|---|---|
| `gorokhovdenis/yandex-disk-mcp` [36] | TypeScript | 4 | **2026-10-18** | **stdio only** (`StdioServerTransport`) | 17 | The liveliest by commit date and the most careful by behaviour: `.part` files renamed only after size+MD5 match, a 60-second wait for async finalisation, per-direction proxy env (`YANDEX_DISK_UPLOAD_PROXY`/`DOWNLOAD_PROXY`), background upload/download jobs with status/cancel. But **stdio only** (no HTTP transport anywhere in `src/index.ts`), the npm package `yandex-disk-mcp` is still **0.1.0 from 2026-01-19** while the repo is at 0.4.0, and the token is a static `process.env.YANDEX_DISK_TOKEN` with no refresh path. |
| `Patr56/yadisk-mcp` [35] | Python (FastMCP) | 1 | 2026-04-08 | **stdio only** (`mcp.run()`) | 22 | Widest tool surface and the only one with tests (9 files, CI), a real `--read-only` flag, and an upload allowlist. Fatal detail: `search_files` calls `client.search(...)` — the pinned `yadisk>=3.0,<4.0` library **has no `search` method** (grep of `yadisk` 3.4.1 `src/` finds zero occurrences), and the test stubs `patched_client.search` so CI is green against a method that does not exist. On PyPI at 0.1.2, single author, one commit day. |
| `denis-samatov/yandex-workspace-mcp` [37] | Python | 0 (2 forks) | 2026-10-16 | **stdio *or* `streamable-http`** (`MCP_TRANSPORT`, `MCP_PORT`, `MCP_AUTH_TOKEN`) | 22 Disk + 27 Wiki + a unified `search` | The only one that can be `tools.url` without a wrapper, and the only one designed like a security product: read-only by default, separate `DISK_READ`/`DISK_WRITE`/`DISK_DELETE` gates, `DISK_ALLOWED_ROOTS`, audit log of writes and destructive ops, `disk_empty_trash` refused unless roots include `/` **and** `DISK_ALLOW_GLOBAL_DESTRUCTIVE=true` **and** the call passes `confirm=true`, cursors "fail closed". Also the youngest (created 2026-08-10), zero stars, and it bundles a Yandex-Wiki half a Disk integration does not need — large surface, no users. |
| `colibri11/yad` [38] | TypeScript | 1 | 2026-06-15 | stdio (+ OpenClaw plugin) | 9 Disk / 26 all services | Uses **app passwords + WebDAV** for Mail/Calendar/Contacts and an optional OAuth token for Disk above ~10 MB, because "Yandex's WebDAV gateway deliberately throttles and drops connections on large uploads". Its proxy section is the most useful artefact in the whole set: uploads/downloads above 10 MB go to *dynamic* CDN hosts `uploader*.disk.yandex.net` / `downloader*.disk.yandex.net`, so a proxy ACL must allow `*.disk.yandex.net:443` **and** `cloud-api.yandex.ru:443`, and splitting them across `NO_PROXY` makes metadata and bytes take different paths. Toy-level product, excellent field notes. |
| `NextStat/yacli` [39] | Rust | 27 | 2026-03-15 | stdio + `http --listen 127.0.0.1:8787` + MCP Apps | mail/calendar/disk/account/auth | The most-starred and the most complete (a CLI *and* an MCP server, keyring storage, 13 embedded skills, MCP Apps UI). But: app passwords for Mail/Calendar, secrets in the system keyring (a container has none unless you mount one), Russian-only docs, and no commit since 2026-03-15. Its Disk surface is a thin subset. |
| `yermidi-bot/yandex-disk-mcp` [40] | Python | 0 | 2026-09-14 | stdio | "view, upload, download, create — no modifications" | One commit, one file, no tests. Not a candidate. |

**The SDK situation underneath them.** `ivknv/yadisk` (LGPL-3.0, 160 ★, last commit 2026-04-16) is the Python client
everyone builds on; it exposes `refresh_token()` [41] and `/v1/disk/resources/files`, but no search [41]. The *official*
Java SDK (`yandex-disk/yandex-disk-restapi-java`, Apache-2.0) is the only official client and its last commit is
**2015-09-22** [42] — treat it as documentation, not as a dependency. rclone's `yandex` backend (Go, MIT) is the most
battle-tested implementation of the whole API in existence and documents the traps that no MCP server has [43].

**Verdict.** Nothing off the shelf is a drop-in for mason: four of the six speak stdio only, the fifth (`yacli`) shows
its HTTP transport bound to loopback, the sixth (`yandex-workspace-mcp`) speaks `streamable-http` but is three months old
with no users, none of them refreshes a token, and none of them separates "mint a capability URL" from "move the bytes" —
which is the shape this deployment needs (§5). [inference] The realistic options are
*wrap* `gorokhovdenis/yandex-disk-mcp` behind an stdio→HTTP bridge (adds a second process and still no refresh) or
*write* ~17 thin tool handlers against the REST API (≈600 lines of TypeScript, the same size as `mason-telegram`). The
second is cheaper than owning someone else's bugs.

## 5. What the mason integration would look like

`mason-yandex-disk`, one container, image built from `integrations/yandex-disk/`, both faces of ADR-0003 — but only one
of them is a *push* face, and it is a poller.

### The tools face — MCP over Streamable HTTP on `:8082/mcp`

Stateless, one `McpServer` and transport per request, exactly like `mason-telegram`: no session id, no per-session state,
so either end restarting is a reconnect.

| Tool | What it does |
|---|---|
| `disk_usage()` | Total, used and Trash bytes plus the system folder paths — the numbers to read before filling the Disk. |
| `disk_list(path, limit?, offset?, sort?)` | One page of a folder: name, type, size, modified, md5; `limit` defaults to 20, so the caller pages with `offset`. |
| `disk_stat(path)` | One resource's metadata — size, md5, modified, `public_url` when it is published. |
| `disk_recent(limit?, media_type?)` | The last N files uploaded anywhere on the Disk, whoever uploaded them. |
| `disk_mkdir(path)` | Creates one folder at `path`. |
| `disk_copy(from, to, overwrite?)` / `disk_move(from, to, overwrite?)` | Server-side copy and move/rename; returns the operation link when Disk answers `202`. |
| `disk_request_upload(disk_path, overwrite?)` | Mints a **token-free PUT URL good for 30 minutes** and returns it with the byte ceiling, so the tool machine's own `curl -T` moves the file. The container never sees the bytes. |
| `disk_upload_text(disk_path, text, overwrite?)` | Writes a short file inline (≤64 KiB) for notes and configs, where a shell round trip is not worth it. |
| `disk_upload_from_url(url, disk_path)` | Asks Disk to fetch a public URL itself; returns the operation id. Nothing transits our networks. |
| `disk_download_url(path)` | Mints a pre-signed GET URL for the tool machine to `curl -o`. |
| `disk_publish(path)` / `disk_unpublish(path)` | Publishes and returns `public_url` (`https://yadi.sk/...`) + `public_key`; unpublish kills both. |
| `disk_delete(path, permanently?)` | Trash by default; `permanently=true` is the one that cannot be undone. |
| `disk_trash(limit?, offset?)` | Trash contents with `origin_path`, so a restore knows where the file came from. |
| `disk_restore(path, name?, overwrite?)` / `disk_empty_trash(path?)` | Restore one resource, or empty the whole Trash / one path in it. |

Three things this table refuses, on purpose:

- **No `disk_search`.** The API has no search endpoint [10] and paging a whole Disk per query is a trap that one MCP
  server has already fallen into (§4). `disk_recent` plus `disk_list` is the honest surface; the model can list.
- **No upload from a local path.** The agent's files live in `mason-env`, the container cannot read them, and the
  container must not gain a route to `mason-env` (`deploy/README.md`: "`mason-env` is not on `mason-mcp`, and must not
  be"). So the tool mints a capability URL and the *tool machine* — which already has `mason-edge` egress "because a
  tool that can work on a repository needs to clone, `gh` and `curl`" — does the PUT, with no token at all [4].
- **No `app:/` in any argument's contract.** The container prefixes it: every path argument is relative to a single
  configured root (`YANDEX_ROOT`, default `app:/`), and every response path is normalised back (because Disk answers
  `disk:/Приложения/Foo/...` for an `app:/` write [3]). [inference] This is the one place where the container enforces
  the boundary rather than the token: `cloud_api:disk.write` is not per-folder, so the root is a convention, not a
  capability — unless the app is registered with `cloud_api:disk.app_folder` alone, in which case Yandex enforces it
  [3].

### The trigger face — there is nothing to subscribe to, so it polls

**Yandex Disk has no webhooks and no change-feed.** The v1 reference's own inventory of what the API can do is: metadata,
upload, download, create folder, copy, move, delete, publish/unpublish, trash, operations [1][22 — the same list since
2015]. There is no registration endpoint, no callback, no event stream, and no `since` cursor on any read [8][10][11].
[inference] Therefore the second face is the telegram pattern, not a webhook: a poller with an offset file.

- **Poll**: `GET /v1/disk/resources/last-uploaded?limit=50` every `POLL_INTERVAL_SECONDS` (default 120). One request per
  poll — 720 requests a day, against a 40 rps ceiling [23].
- **Diff**: `last-uploaded` takes `limit`, `media_type`, `fields`, `preview_*` and **no time filter** [11], so the
  container keeps `seen.json` on `/data` (path → `{md5, modified}`) and emits only the file paths it has not seen.
  [inference] Name+md5 is the right key: `modified` changes on a rename, and md5 catches a replaced file at the same
  path.
- **Event envelope**, exactly the door's contract (`v`, `id`, `kind`, `payload` as a string):
  ```json
  {"v":1,"id":"yd-3f9c1a7b2e5d40c8","kind":"disk.file.added",
   "payload":"report-2026-10.pdf (1.2 MB) appeared at disk:/Documents/report-2026-10.pdf"}
  ```
  The id is derived, because Yandex gives no event id: `yd-` + the first 16 hex of `sha256(path|md5)` — stable across a
  redelivery, and unique per (path, content) [inference]. A path longer than the door's 2 000-character payload cap is
  cut here with `… [truncated]`, for the telegram reason: the door refuses an over-long payload rather than truncating
  it.
- **Auth of the trigger**: identical to `mason-telegram` — `x-mason-signature: sha256=<hex hmac-sha256 of the raw body>`
  keyed by `MASON_TRIGGER_SECRET`, minted on the mason side by
  `npm run integration -- secret yandex-disk --hook disk-drop`, posted to `http://mason:8787/api/events/yandex-disk`
  [ADR-0003; `deploy/README.md`]. `202` expected; `429` honours `retry-after`; a door that cannot be reached does not
  advance the cursor; a `400/401/404/405/413` advances past it, because a retry would get the same answer.
- **The hook** `disk-drop` must exist in `src/server/hooks.ts` before the container's first event, because "mason refuses
  to boot if `integrations.json` names a hook this build does not define" (`integrations/telegram/README.md`). Its
  `promptTemplate` is where "a file arrived on Disk; decide whether it matters" belongs — not in this container.
- **A cursor that never replays history.** A volume that has never held `seen.json` runs one `last-uploaded` call,
  records what it finds, and emits nothing — the telegram rule ("a restart must never replay yesterday's chat") applied
  to a Disk.

### Container shape, env vars, volumes

| Variable | Required | What it is |
|---|---|---|
| `YANDEX_CLIENT_ID` | yes | The app's ClientID, from `oauth.yandex.com` [28]. |
| `YANDEX_CLIENT_SECRET` | yes | The app's secret; needed for `grant_type=refresh_token` [25]. Never logged. |
| `YANDEX_REFRESH_TOKEN` | yes | The seed grant, printed once by the bootstrap (`npm run auth` in the container). Rotated on every refresh and re-written to `/data`; the env value is only the recovery path. |
| `MASON_EVENT_URL` | yes | `http://mason:8787/api/events/yandex-disk` on the compose network. |
| `MASON_TRIGGER_SECRET` | yes | The HMAC key the door verifies with, ≥32 characters, minted once on the mason side. |
| `YANDEX_ROOT` | no | The one namespace any tool may touch: `app:/` (default), or `disk:/Agent` if the app holds broad scopes. |
| `YANDEX_READ_ONLY` | no | `1` removes every write, move, delete, publish and empty tool from the surface — the Patr56 flag, kept [35]. |
| `YANDEX_ALLOW_PUBLISH` | no | `0` (default) removes `disk_publish`/`disk_unpublish`: a published file is a public URL that outlives the conversation [18][19]. |
| `POLL_INTERVAL_SECONDS` | no | Default 120. `0` disables the trigger face entirely and the container is tools-only. |
| `HTTPS_PROXY` | no | The VPN sidecar, `http://vpn:1080`. Node 22's `fetch` ignores it, so the API calls go through `undici`'s `ProxyAgent` — the same `src/fetch.ts` the telegram container already has [telegram README]. |
| `DATA_DIR` / `PORT` | no | `/data`, `8082`. Moving `PORT` means moving `tools.url` too. |

- **Networks**: `mason-mcp` (mason reaches `:8082` by name) and `mason-egress` (`internal: true`, whose only reachable
  address is the `vpn` sidecar). No `ports:`, ever. [inference] If Denis's host reaches Yandex directly, `mason-edge`
  instead of `mason-egress` — the same choice the telegram container documents.
- **Proxy ACL, and this is the part that will bite**: three hosts, not one. `cloud-api.yandex.net:443` for everything in
  the table, `oauth.yandex.com:443` for the refresh (and the device-code bootstrap), and — because upload and download
  `href`s point at the storage service and "you need to access the file download service and the Yandex Disk storage
  separately" [2] — a **dynamic** CDN host `uploader*.disk.yandex.net` / `downloader*.disk.yandex.net`, assigned per
  request [38]. A `dstdomain cloud-api.yandex.net` rule uploads nothing, and the failure reads as a generic tool error.
- **A second egress path outside the container**: the tool machine's `curl -T` / `curl -o` for the bytes [4][6]. It rides
  `mason-edge`, which `mason-env` already has and which `deploy/README.md` says to delete if you want the fence back —
  deleting it breaks every large transfer, and nothing in the integration's own config says so.
- **Volumes**: one, `/data`, holding `token.json` (0600, atomic), `seen.json` (0600, atomic, whole-file per poll) and
  nothing else. No transcript, no cache of file bytes.
- **`integrations.json`**: `{"yandex-disk": {"enabled": true, "description": "The owner's Yandex Disk files, under
  app:/", "tools": {"url": "http://mason-yandex-disk:8082/mcp"}}}` — plus the trigger secret, which the `secret`
  subcommand writes.
- **What it never does**: speak as the owner, hold the transcript, or reach `mason-env`. Its whole vocabulary is one
  event out and a capability URL back.

## 6. Risks and the month-two failure

**The month-two failure is the token, and it is not the expiry — it is the revocation.** A renewable token is good for
"at least 1 year" [24], which is long enough that nobody builds monitoring for it, and short enough that the first
password change, the first time 2FA is switched on or off, or the first "log out everywhere" silently kills the grant
[30]. So does a scope edit in the OAuth console, which revokes **every token ever issued to that app** [30]. The
container's behaviour then is a `401` on every tool call, a poller that logs the same line every two minutes, and an
agent that reports the Disk as empty unless the tool surface refuses instead of lying [inference]. The mitigation is
structural, not procedural: refresh on a timer (every ≤90 days, as the docs recommend [25]), treat `401` as "refresh,
then retry once", and make the tool return a hard error naming the grant rather than an empty listing.

**The second, quieter failure is the monthly upload cap.** 2× the Disk's size per rolling 30 days on the personal plans,
3× on Pro [33], against a 5 GB free Disk [33] — so ~10 GB, and the window resets "30 days from the first upload", not on
the 1st [33]. When it trips, writes return `423` with `UPLOAD_TRAFFIC_LIMIT_EXCEEDED` [45], *the same code* as a
maintenance window [45], so the log says nothing useful unless the container reads `error` and not just the status
[inference]. An agent that stores screenshots or exports will discover this in week three.

**The third is Trash accounting.** Deleting to Trash does not free space [15], and `disk_delete(permanently=false)` is the
default a cautious agent wants. A month of agent deletions can fill `trash_size` until writes fail `507` while the human's
web UI shows plenty of room [7][4]. `disk_usage()` returning `trash_size` beside `used_space` is the whole mitigation,
plus `disk_empty_trash` behind `YANDEX_READ_ONLY`'s inverse and, ideally, a confirm argument — the shape the
workspace server already uses [37].

**The contractual risks, which are worse than the technical ones.** The API terms reserve the right to "изменять,
исправлять или обновлять Сервис в любой момент, без предварительного уведомления", to "прекратить или приостановить
доступ Пользователя к Сервису без уведомления", and to change the terms themselves with no notice [23]. The docs'
change history has been frozen since **2015** [22], which reads as stability but means there is no deprecation channel
to watch: a change arrives as a `4xx` in production. The terms also require attribution — "размещения информации об
использовании технологии Яндекса в описании программного продукта" and the Disk logo in the interface elements that
reach Disk [23] — which a private agent for one person almost certainly does not need and a public one certainly does
[inference]. And the ToS's own rate clause treats sustained excess as grounds for termination, not throttling [23].

**Two smaller ones worth writing down.** The `app:/` folder is the *user's* folder: "Users have full access to files in
the Apps folder, which means they can delete, move, and rename them" [3] — a human tidying their Disk can delete the
agent's scratch directory, and the folder's own name depends on the account's interface language (`Приложения` vs
`Applications`) [3][7], so nothing may hard-code it. And the upload path is asynchronous [4][43]: a tool that uploads and
immediately renames or publishes will intermittently act on a file that does not exist yet.

**What is *not* a risk, on the evidence.** No inbound anything: no webhook to expose, no port to publish, no public URL,
so the fence stays as it is. No datacenter-IP block on the API: from this host, over plain HTTPS, the API answered with a
JSON `401` and a request id (probe, §1), and the MCP servers that document proxy setups assume `cloud-api.yandex.net` is
reachable through an ordinary egress proxy [38]. Yandex's *web* pages are a different matter — `yandex.ru/dev/disk/webdav/`
served this host a SmartCaptcha challenge while the docs' `.md` endpoints answered normally (observation, 2026-10-26) —
which matters only because a human bootstrap that has to open `oauth.yandex.com` from a server's browser would be
unpleasant; the device flow avoids that entirely by putting the browser on the human's own machine [27].

## 7. Recommendation

**Small.** Build `integrations/yandex-disk/` as one TypeScript container, Node 22 from source with
`--experimental-strip-types`, no build step — the `mason-telegram` shape and roughly its size (≈500–700 lines across
`src/tools.ts`, `src/api.ts`, `src/auth.ts`, `src/poller.ts`, one `src/server.ts`, one `Dockerfile`, one
`compose.yandex-disk.yaml` service on `mason-mcp` + `mason-egress`, one `/data` volume) [inference: the API is a dozen
endpoints and the hard parts — the door, the HMAC, the offset discipline, the proxy agent — already exist in the
telegram container and can be lifted]. Do **not** start from a community MCP server: four of the six speak stdio only, none of
them refreshes a token, and the widest-tooled one calls a library method that does not exist. Register the OAuth app
as **"For API access or debugging"** with `cloud_api:disk.app_folder` + `cloud_api:disk.info` first, so the agent
physically cannot touch the owner's own files, and treat widening to `read`/`write` as a later, deliberate second grant
[3][28].

**First three steps.**

1. **Prove the grant, in a terminal, before any container exists.** Create the app at `oauth.yandex.com` (type: for API
   access; permissions: `cloud_api:disk.app_folder`, `cloud_api:disk.info`), run `POST /device/code`, have Denis type
   the `user_code` at `https://oauth.yandex.com/device` from his own browser, exchange `device_code` for
   `access_token`+`refresh_token`, then `GET /v1/disk/` and `GET /v1/disk/resources?path=app:/` with
   `Authorization: OAuth …` and record what the `app:/` paths come back as (`disk:/Приложения/<app>/...`) [27][2][3]. This
   settles the one unverified question in this note — whether an *API-access* app may use the device flow — for the cost
   of one curl script.
2. **Write the token half as a standalone module with tests, and nothing else.** `refresh()` on a timer at ≤90 days, on
   `401`, and on startup; `expires_in` → absolute timestamp from the response's own header `Date` rather than the local
   clock [inference: the docs' `expires_in` example of 124 234 123 534 seconds is not a number to trust [25]];
   `/data/token.json` written whole, 0600; a `401` that survives a refresh is a hard tool error naming the grant, never
   an empty listing [30]. Node's `fetch` does not read `HTTPS_PROXY`, so the `undici` `ProxyAgent` comes over from the
   telegram container untouched.
3. **Then the fourteen tools, then the poller — in that order, and the poller last.** The tools face is what makes the
   integration worth having; the trigger face is a 60-line loop over `last-uploaded` with a `seen.json` and a derived
   event id, and it needs the `disk-drop` hook in `src/server/hooks.ts` to exist before its first event, or the boot
   refuses. Ship it with `POLL_INTERVAL_SECONDS=0` for the first week and turn the trigger on once `disk_list` has shown
   that the path normalisation is right.

**What I would watch in month two**, in one line each: a `401` storm that is a revocation, not a bug [30]; `423
UPLOAD_TRAFFIC_LIMIT_EXCEEDED` on the rolling 30-day window [33][45]; `507` while the human sees free space, which is
Trash [7][15]; and a `docker compose up` that silently drops the `*.disk.yandex.net` ACL and makes every large transfer
fail while every metadata call succeeds [38].

---

## Contradictions

- **The maximum file size is 50 GB or 100 GB depending on which language of the same help article you read.** English:
  "With any Yandex 360 plan — 50 GB… You can't upload a file larger than 50 GB" [31]. Russian, same article: "С тарифами
  Яндекс 360 Для профи — 100 ГБ", with a separate section "Больше 50 ГБ (подключен тариф Для себя или Для семьи)" → "Для
  профи" [32]. The API docs refuse to give a number at all and point at the tariff [45]. Recorded, not resolved; an
  integration should assume 1 GB unless the account has a plan.
- **The 10 GB / 350 MB upload figures in the brief do not exist in any current Yandex document I read** [4][5][31][32]
  [45]. The nearest real things are the undocumented `Content-Range` resumable path (`412` on a bad range) [4] and the
  dead Java SDK that used it [42]. I could not retrieve a pre-2022 revision of the upload pages from the Wayback Machine
  to check whether those numbers were once published, so the history is unverified — but the current contract is 1 GB /
  50 GB.
- **Rate limits: 40 rps in the terms of use [23], no number anywhere in the API reference, and a `429` on every endpoint
  [4][6][9][15][16].** These are not contradictory so much as two different instruments — a contract and a status code —
  and the practical throttling point is unpublished. Users hit `429` on the WebDAV door at volumes far below 40 rps
  [rejected source, see Sources], which suggests the effective limit is per-account and unstated [inference].
- **A "renewable" token lives a year, but refresh returns `expires_in: 124234123534`** (~3 940 years) in the docs' own
  example [24][25]. Either the example is a placeholder or the field is not the token's lifetime in production; nothing
  in the docs resolves it [inference].
- **`cloud_api:disk.app_folder` is a real sandbox, and it is not private.** Yandex enforces the folder boundary [3], and
  the user can delete, move or rename everything inside it [3]. Both are documented; they are only contradictory if one
  reads "app folder" as "app-owned".

## Missing evidence

- **Whether an "API access" app may use the device-code flow.** The device flow is documented without a platform
  requirement [27] and the API-access app type pins `redirect_uri` and says nothing about device authorisation [28].
  Step 1 of the recommendation is designed to answer this empirically.
- **Whether the old refresh token stays valid after a refresh.** The docs say the response contains "a new refresh
  token" [25] and never say the old one dies. Until verified, keep the previous token for one cycle [inference].
- **Any documented numeric rate limit for `cloud-api.yandex.net`.** Not in the reference, not in the help pages; only the
  40 rps contractual ceiling [23]. No `Retry-After` behaviour is documented either.
- **The lifetime of a download `href`.** "Время жизни ссылки на скачивание ограничено" and no number [6].
- **Whether `limit` has a maximum.** The reference gives the default (20) and no ceiling [21]; every client picks its own.
- **Whether `PUT /v1/disk/resources?path=a/b/c` creates missing intermediate folders.** Not stated in the create-folder
  reference [12]; one MCP server claims recursive creation and does it itself, which is weak evidence [35].
- **Trash retention.** No automatic-purge period appears in the API reference or in the Yandex 360 storage article I
  read [7][15][33]; the trash help page I tried returned 404. Do not claim one.
- **What a `429` actually costs on the Disk API** — whether it is per token, per account or per IP. Undocumented.
- **Whether Yandex blocks the API from any region or IP range.** Nothing in the docs says so, and this host was served
  normally (§1), but "no evidence of blocking" is not the same as "documented as permitted".

## Sources

Kept — Yandex's own documents (the docs site serves each page as Markdown at the same URL with `.md` appended, which is
how these were read verbatim):

1. Introduction — Yandex Disk REST API — https://yandex.com/dev/disk-api/doc/en/index.md — the API's own statement of
   what it can do (metadata, upload, download, folders, copy, move, delete).
2. Access to API — https://yandex.com/dev/disk-api/doc/en/concepts/quickstart.md — host, `v1`, JSON-only, the four
   `cloud_api:disk.*` scopes, the `Authorization: OAuth` header, the debug-token URL, the two-service split for
   upload/download.
3. App folders — https://yandex.com/dev/disk-api/doc/en/concepts/app-folders.md — `app:/`, auto-creation, name
   collisions, the `disk:/Apps/...` rendering, and the user's full access.
4. Uploading a file to Yandex Disk — https://yandex.com/dev/disk-api/doc/en/reference/upload.md — the two-step flow,
   30-minute `href`, token-free PUT, 255/32 760 character limits, `201`/`202`/`412`/`413`/`507`.
5. Downloading a file from the internet to Yandex Disk — https://yandex.com/dev/disk-api/doc/en/reference/upload-ext.md —
   upload by URL, `202` + operation, `disable_redirects`, no retry on error.
6. Downloading a file from Yandex Disk — https://yandex.com/dev/disk-api/doc/en/reference/content.md — pre-signed
   download `href`, limited lifetime.
7. Data about the user's Yandex Disk — https://yandex.com/dev/disk-api/doc/en/reference/capacity.md — `total_space`,
   `used_space`, `trash_size`, `system_folders`.
8. File and folder meta information — https://yandex.com/dev/disk-api/doc/en/reference/meta.md — the Resource object,
   `_embedded` paging, `fields`.
9. Тот же документ, русская версия — https://yandex.ru/dev/disk-api/doc/ru/reference/meta.md — the `trash:/cat.png` and
   `origin_path` examples, the `trash:/foo_1408546879` suffix, `429` on the list endpoint.
10. Flat list of all files — https://yandex.com/dev/disk-api/doc/en/reference/all-files.md — the only "find a file by
    type across folders" call, and the evidence that there is no query-string search.
11. Recently uploaded files — https://yandex.com/dev/disk-api/doc/en/reference/recent-upload.md — `last-uploaded`, its
    parameters and the absence of a time cursor.
12. Creating a folder — https://yandex.com/dev/disk-api/doc/en/reference/create-folder.md — `PUT /v1/disk/resources`.
13. Copying a file or folder — https://yandex.com/dev/disk-api/doc/en/reference/copy.md
14. Moving a file or folder — https://yandex.com/dev/disk-api/doc/en/reference/move.md
15. Deleting a file or folder — https://yandex.com/dev/disk-api/doc/en/reference/delete.md — `permanently`, and the
    statement that Trash does not free space (the RU page states it explicitly:
    https://yandex.ru/dev/disk-api/doc/ru/reference/delete.md).
16. Emptying Trash — https://yandex.com/dev/disk-api/doc/en/reference/trash-delete.md — `DELETE
    /v1/disk/trash/resources`.
17. Restoring from Trash — https://yandex.ru/dev/disk-api/doc/ru/reference/trash-restore.md — `PUT
    /v1/disk/trash/resources/restore`.
18. Publishing — https://yandex.ru/dev/disk-api/doc/ru/reference/publish.md — `public_key`, `public_url`, `PUT`, and the
    403 reasons including "Диск в режиме «только чтение»".
19. Unpublishing — https://yandex.ru/dev/disk-api/doc/ru/reference/unpublish.md — removes `public_key` and `public_url`.
20. Operation status — https://yandex.com/dev/disk-api/doc/en/reference/operations.md
21. General HTTP parameters — https://yandex.com/dev/disk-api/doc/en/reference/parameters-warehouse.md — `limit` default
    20, `offset`, `sort`, `media_type`, `preview_size`.
22. API change history — https://yandex.com/dev/disk-api/doc/en/concepts/releases.md — v1 only, backward compatible,
    last entry 2015-12-16.
23. Условия использования сервиса «API Яндекс.Диска» — https://yandex.ru/legal/disk_api/ — 40 requests per second (2.2),
    no-notice changes and suspension (2.11, 2.13, 5.1), attribution and logo duties (2.4–2.5), token non-transfer (4.2),
    published 2026-02-27.
24. OAuth implementation at Yandex — https://yandex.ru/dev/id/doc/en/concepts/ya-oauth-intro.md — token lifetime,
    renewable vs restricted, and the revocation paths.
25. Update a token — https://yandex.ru/dev/id/doc/en/tokens/refresh-client.md — `grant_type=refresh_token`, the new
    refresh token, "refresh every three months", the `expires_in` example.
26. Obtain a token manually — https://yandex.ru/dev/id/doc/en/tokens/debug-token.md — the paste path and the URL
    fragment.
27. Entering the code on the authorization page — https://yandex.ru/dev/id/doc/en/codes/screen-code-oauth.md —
    `POST /device/code`, `user_code`, `verification_url`, `interval`, 10-minute code, `grant_type=device_code`, the
    30-device-token cap.
28. App registration for API access — https://yandex.ru/dev/id/doc/en/register-api.md — the "For API access or
    debugging" type, the fixed `redirect_uri`, the verification warning.
29. Registering an app — https://yandex.ru/dev/id/doc/en/register-client.md — the two app types, the three-group limit
    on authorisation apps, type immutability.
30. Отзыв токенов — https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate.md — every revocation trigger, including
    password change, 2FA toggle, and an owner's scope edit revoking all tokens for the app.
31. Uploading files (Yandex 360 help, EN) —
    https://yandex.com/support/yandex-360/customers/disk/web/en/uploading — 1 GB without a plan, 50 GB with one.
32. Загрузка файлов (Yandex 360 help, RU) —
    https://yandex.ru/support/yandex-360/customers/disk/web/ru/uploading — the same table plus "Для профи — 100 ГБ".
33. Manage your storage space (EN) —
    https://yandex.com/support/yandex-360/customers/disk/web/en/enlarge/disk-space — 5 GB free, the 2×/3× monthly upload
    cap, the 30-day reset, and what "upload restricted" means. RU twin:
    https://yandex.ru/support/yandex-360/customers/disk/web/ru/enlarge/disk-space.
34. Регистрация в Яндекс ID — https://yandex.ru/support/id/ru/authorization/registration — registration by phone number.
35. `Patr56/yadisk-mcp` — https://github.com/Patr56/yadisk-mcp (source read at
    https://raw.githubusercontent.com/Patr56/yadisk-mcp/main/yadisk_mcp/server.py, tests at
    https://raw.githubusercontent.com/Patr56/yadisk-mcp/main/tests/test_listing.py, deps at
    https://raw.githubusercontent.com/Patr56/yadisk-mcp/main/pyproject.toml) — 22 tools, FastMCP stdio, `--read-only`,
    and the `client.search` call that its test stubs rather than exercises.
36. `gorokhovdenis/yandex-disk-mcp` — https://github.com/gorokhovdenis/yandex-disk-mcp (source read at
    https://raw.githubusercontent.com/gorokhovdenis/yandex-disk-mcp/main/src/index.ts, metadata at
    https://registry.npmjs.org/yandex-disk-mcp) — 17 tools, `StdioServerTransport`, `Authorization: OAuth`,
    per-direction proxy env, npm stuck at 0.1.0.
37. `denis-samatov/yandex-workspace-mcp` — https://github.com/denis-samatov/yandex-workspace-mcp — the only candidate
    with `streamable-http` + `MCP_AUTH_TOKEN`, and the permission-gate design worth copying.
38. `colibri11/yad` — https://github.com/colibri11/yad — app passwords + WebDAV for Mail/Calendar, and the
    `uploader*.disk.yandex.net` / `downloader*.disk.yandex.net` proxy finding.
39. `NextStat/yacli` — https://github.com/NextStat/yacli — CLI + MCP + MCP Apps in Rust, keyring storage, HTTP transport
    on `127.0.0.1:8787`.
40. `yermidi-bot/yandex-disk-mcp` — https://github.com/yermidi-bot/yandex-disk-mcp — one commit, not a candidate.
41. `ivknv/yadisk` — https://github.com/ivknv/yadisk (v3.4.1, LGPL-3.0) — the Python client under the most-used MCP
    server; `refresh_token()` exists, `search()` does not.
42. `yandex-disk/yandex-disk-restapi-java` — https://github.com/yandex-disk/yandex-disk-restapi-java — official,
    Apache-2.0, last commit 2015-09-22; the only client that used `Content-Range` chunking.
43. rclone: Yandex Disk — https://rclone.org/yandex/ — the pacer and retry codes, async finalisation and the 1.5–3 s
    wait, the >5 GiB pause and timeout advice, and the mail-account prerequisite.
44. `yandex-cloud/mcp` — https://github.com/yandex-cloud/mcp — the official MCP family, Cloud-only, IAM-token
    authenticated, 12-hour token ceiling.
45. Загрузка файла на Диск (RU) — https://yandex.ru/dev/disk-api/doc/ru/reference/upload.md — `UPLOAD_FILE_SIZE_LIMIT_EXCEEDED`
    and `UPLOAD_TRAFFIC_LIMIT_EXCEEDED`, the `423` that shares a code with maintenance, and the deferral of both limits
    to the tariff.

Rejected / deprioritised:

- **The Yandex WebDAV developer page** (`https://yandex.ru/dev/disk/webdav/`) — served this host a SmartCaptcha
  interstitial instead of the page; not read, not cited. It is worth a second attempt through a browser if a WebDAV
  variant of this integration is ever considered.
- **`remotely-save` issues #1026/#1028/#1034/#1100** — the richest public evidence of Yandex throttling in practice
  (a year of `429`s on the WebDAV door, a fix that adds exponential retry), but user reports and one support transcript,
  not documentation. Useful as a smell, not as a fact.
- **Two Russian SEO/LLM-generated "Yandex API in PHP/Python" articles** (`xtool.ru`) — they invent plausible limits ("5
  requests per second", "20 requests per second", "250 requests a day") that contradict each other inside one page and
  appear in no Yandex document. Excluded outright; the 40 rps figure comes from the terms of use instead.
- **`yadisk.readthedocs.io` module pages** — generated source listings of the same `yadisk` library, redundant with [41].
- The `docs/research/always-on-agents` note in this repo — read for house style only.
