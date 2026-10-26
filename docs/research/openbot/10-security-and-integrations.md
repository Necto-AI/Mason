# Security, identity and integrations in openbot

## What it is

openbot is shaped like a multi-tenant bot product but built single-tenant: one deployment, one Postgres, one
`KEY_ENCRYPTION_KEY`, "team" meaning everyone who can sign in. Its security screens rest on Better Auth, one
encrypted vault with pointer rows elsewhere, per-Bot grant rows whose absence *is* the refusal, and an
append-only trail.

## How it works

### Identity: one deployment, one organisation, two roles

No `organizations` table; tenancy is the deployment. Better Auth (`server/src/auth/index.ts:218-260`)
registers `expo` only when `EXPO_PROJECT_ID` is set, since any Android app can claim the scheme
(`:211-217`), plus `scim`, `electron`, optional Okta, and an always-on `sso` plugin for SAML/OIDC providers
registered at runtime.

Roles are `"admin" | "user"` and nothing else (`server/src/auth/roles.ts:5`). `user_roles` is a set keyed
`(user_id, role)` (`server/src/db/schema/core.ts:167-177`); the guard takes `admin` if *any* row says so and
answers `403` when none does (`server/src/auth/guards.ts:55-91`). `INITIAL_ADMIN_EMAILS` is a floor, not a
role: re-applied on every sign-in (`roles.ts:85`, called at `auth/index.ts:509`), only ever promoting, and
writing `person.admin_by_configuration` when it is what granted the role (`auth/index.ts:531`).

Getting in is one function (`auth/index.ts:52-70`): `sso-oidc`/`sso-saml`/`scim` always pass; otherwise the
`ssoRequired` setting decides, a break-glass address is admitted and audited as `session.break_glass`
(`:291-303`), everyone else refused and audited (`:305-315`). The setting is read through a `catch` that
defaults to *required* (`:60-64`); turning it on deletes the sessions of everyone who never signed in through
a registered IdP (`server/src/auth/sso-required.ts:7-46`).

The deny list is keyed on the *address*, not the id, and checked on user creation (`auth/index.ts:393-429`)
and again on session creation (`:454-497`), because the user hook fires only for new accounts; removal
deletes sessions in the same transaction (`server/src/people/store.ts:296-315`). Domain allowlisting calls
itself a filter, not a boundary (`auth/email-domain.ts:1-16`).

Groups come from the directory: SCIM projects them into `users.groups` (`server/src/auth/scim.ts:160-186`),
which per-group capability rows and network policies read (`admin/settings-store.ts:227-235`). **The schema
disagrees**: `db/schema/core.ts:74-83` still says `users.groups` is "empty on every row … and nothing reads it".

The desktop's organisation mode delegates identity instead: only the `better-auth.session_token` cookie is
forwarded (`auth/organization.ts:63-69`), via a 60-second single-use ticket (`:186-205`).

### Sessions and machine identity

Human identity is a cookie (`db/schema/core.ts:98-109`), checked with `disableCookieCache: true` so revocation
lands on the next call (`auth/guards.ts:57-60`). There is **no personal API key**. Machine identity is
per relationship: an `obot_agt_` callback token stored only as SHA-256 plus a 10-minute signed run assertion
naming Bot and person, so a token cannot spend another Bot's grants
(`server/src/agents/callback-token.ts:9-45`); a customer agent's bearer in the vault with only
`{header, credentialId}` in configuration (`agents/auth-header.ts:11-30`); a constant-time bearer for the
desktop poller (`host-access/routes.ts:16-25`); the OpenTag shared secret (`delivery/opentag.ts:44-49`); and
an Ed25519 Web Bot Auth identity for a Bot's own browser (`web-bot-auth.ts:9-20`).

### The credential vault

One table (`db/schema/core.ts:408-429`) with a partial unique index on `(kind, provider, key_id) WHERE
revoked_at IS NULL`, so two replicas racing to rotate cannot both insert a live row (`:421-428`). The
envelope is `{version: 1, iv, ciphertext}` under AES-GCM (`server/src/credentials.ts:170-192`).

Six kinds (`core.ts:37-62`): `model`, `connector`, `agent`, `mcp`, plus `mcp_oauth_client` ("what the
deployment holds") and `mcp_user_token` ("what one person holds") kept apart so that question stays
answerable. Everything else stores a pointer: `mcp_servers.credential_id` is a real foreign key with
`onDelete: restrict` (`db/schema/plugins.ts:76-97`).

Revocation is never deletion. Rotation refuses an already-revoked row, a missing row and a mismatched key,
writing `credential.rotation_refused` through `reasonWithoutStatement` (`credentials.ts:593-664`) — because a
`DrizzleQueryError` message carries every bound parameter, so the envelope just built could land in an
append-only audit row exported for the whole retention window. `CredentialUnusableError`
(`credentials.ts:196-241`) is the mirror case: callers substring-matched "revoked", and drizzle's
`Failed query: … from "credentials"` put that substring in every fault, so an outage was reported as an
administrator having withdrawn access.

One vendor secret escapes: `COMPOSIO_API_KEY` / `ARCADE_API_KEY` are environment-only
(`server/src/config.ts:1378-1379`), no screen, no rotation API — inconsistent against `mcp_oauth_client` in
the vault.

### Grants: the per-Bot layer

Credentials are per person or per deployment, never per Bot. The per-Bot layer is `plugin_grants`, keyed
`(kind, ref, agent_id)` (`db/schema/plugins.ts:796-812`); a missing row is a refusal
(`plugins/plugin-store/calls.ts:53-80`). The server row is account-wide, so adding a server to a second Bot
does not re-enter the credential (`db/schema/plugins.ts:28-36`). `mcp_servers.provenance`
(`first-party | custom | composio`) decides which credential the call goes out on (`:69-96`); `access.ts` is
the only module allowed to spell a broker's name, and resolves transport, credential source and `reachedAs` in
one place, with a test exempting that file and no other (`server/src/plugins/access.ts:22-40`).

### The call corridor

Every tool call takes one path, and the order is the design (`plugin-store/calls.ts:90-500`):

```
grant ─► access ─► effect ─► strip __version ─► policy ─► content inspection of outgoing args
  ─► private-share check ─► shared-audience gate ─► approval ─► token ─► vendor ─► outcome row
```

Refusals are audited *before* the throw (`:379-391`), so a caller's error handling cannot lose one. The
inspection judges `vendorArgs`, the object actually sent (`:321-341`), reporting a category and a path but
never the matched value (`plugins/content-governance.ts:1-20`). Where openbot had to choose it chose
deny-by-absence: no fallback token, and a refresh-token exchange that discards the access token, so revocation
is complete by construction (`plugin-store/context.ts:441-452`).

### Approvals

Built-in safety requirements — credentials, security settings, payments — always hand the action to the
person and are **not configurable** (`server/src/approvals/policy.ts:77-133`). Custom rules rank
`allow < pre_approved < ask < hand_off`, a tie going to the team's locked row (`:24-30`, `:56-75`); a model
reviewer can only escalate (`:346-360`). Nine capability switches resolve organisation → role → group, where a
group row **can only widen** (`admin/capabilities.ts:9-16`, `:118-155`); an unreadable one refuses with `503`
(`admin/gate.ts:9`). Enforced at the HTTP edge, mounted once at
`app.use("/api/*", createEnterpriseGate(requireUser))` (`server/src/app.ts:632`), at the synchronous computer
boundary, and in the stores, so a path that never crosses HTTP is refused identically
(`admin/controls.ts:4-20`). `admin/gate.ts:41-58` shows how a gate gets found missing: CopilotKit does not
anchor its routes, so an anchored pattern would have leaked `/api/copilotkit/x/agent/<id>/run`.

### Channels

Slack and Teams go through **OpenTag**, a separate front calling one AG-UI agent with a shared bearer; the
sender context names the person, and that person's delivery binding decides owner, Bot and thread — "nothing
in the message text or the RunAgentInput can choose an owner" (`delivery/opentag.ts:1-19`). SMS is Twilio with
signature verification and its advanced opt-out recorded as state, never a second reply
(`delivery/twilio.ts:8-40`); push is Expo (`delivery/push.ts:1-20`). In-app channels and group chat resolve
membership per request and per turn, never cached, and a non-member gets the same answer as for a channel
that does not exist (`channels/group.ts:12-23`). Voice is OpenAI or xAI realtime (`voice/config.ts:1-25`).

**A dead switch.** `channels.allowed_groups` is a column (`db/schema/core.ts:301`) carried through the tenant
package export and import (`server/src/tenant-package.ts:589-591`, `:939-946`) that no route, store or policy
reads; the stale `users.groups` comment calls it the other half of "the pair" (issue #82).

### Host access

A leased queue, not an inbound socket: the desktop polls and takes a 15-second desk lease
(`host-access/schema.ts:1`, `broker.ts:344-350`), a grant is bound to `(botId, actorId)` (`schema.ts:11-18`),
and command policy is `ask | allow | never`, the stricter of person and team winning, with `never` refused
before the computer hears of it (`broker.ts:287-296`).

### Audit trail

176 event types (`server/src/audit.ts:50`), append-only enforced by a Postgres trigger rather than the
application: `UPDATE` always raises, `DELETE` raises unless the transaction sets
`openbot.audit_retention_days` *and* the row is older than that window
(`server/drizzle/0007_audit_retention_window.sql:20-45`). Retention is opt-in, because "deleting somebody's
audit trail because a default said so is the worse failure of the two" (`audit-retention.ts:1-20`). Payloads
are redacted **by key name** at write time (`audit.ts:18-48`, `:711-735`), honest about its limit: a secret
under an unlisted key is copied. Every row carries `initiator_kind` (`audit.ts:630-637`), and the plugin store
adds `unattributed` — "a run this deployment could not put a name to is not the deployment having acted"
(`plugin-store/model.ts:869-887`).

## Decisions and their reasons

**One organisation per deployment**, so no tenant id reaches a query, at the cost of no teams table: Team Bot
audiences are only `team | people` (`db/schema/team-bots.ts:33-39`) and groups must come from the IdP.

**Vault plus pointers plus grants**, so the trail can say *whose account a call reached* and revoking one
person's credential is something a Bot's config cannot forget.

**Refusal-as-a-row, outcome after the attempt**, so the trail is an investigation tool rather than a success
log — which is why the dry-run bug at `calls.ts:255-290` was findable at all.

## Mason-relevant

- **Worth copying.** *Reserve identity on the envelope before it is needed.* openbot had to invent
  `unattributed` because a run with no attribution had nowhere to say so; mason's v1 envelope is
  `{v, id, kind, payload}` with no actor (`src/server/events.ts:50-55`). mason identifies a sender by the
  integration name in the path plus that integration's own secret — stricter than openbot's one OpenTag bearer
  for all Slack and Teams traffic — so a sender-side actor, if ever wanted, goes inside the signed payload.
  *Put the refusal next to the permission, and the outcome row after the attempt.* openbot wrote `call_succeeded`
  before the vendor call and left a trail asserting the opposite of what happened (`calls.ts:458-476`);
  mason's accept log proves the door took the bytes, and nothing proves a hook accepted the fire. *One door
  per direction.* `plugins/mcp.ts:6-19` is the only module speaking MCP outward, because a second client is a
  second place to forget the timeout, the credential and the cap — as openbot's two broker adapters each name
  the SDK they alone import (`composio-adapter.ts:19-26`, `arcade-adapter.ts:19-26`).
- **Worth avoiding.** A capability matrix that outruns the code checking it: `channels.allowed_groups` is
  stored, exported and read by nothing. Nine switches, three approval layers, a policy expression language and
  a model reviewer are a large surface for a personal agent, and `plugin-store/connections.ts` at 3 528 lines
  is where per-vendor connection lifecycle accumulates.
- **Already right in mason.** Per-integration secrets minted and printed once; a closed envelope vocabulary
  (`KIND_TOKEN`, `ID_MAX`, control-character refusal, over-cap refused rather than truncated,
  `src/server/events.ts:33-47`, `:112`); and a `404` for a disabled integration's door rather than openbot's
  fail-open capability default, which allows everything on a deployment that never opened the screen
  (`admin/capabilities.ts:90-100`). mason also keeps the upstream credential in the container where openbot
  keeps it in the server vault (`plugin-store/context.ts:455-500`); **for mason's integration containers I
  would keep mason's ADR-0003 choice**, because a service that must be taught to authenticate is not a
  generic adapter.

## Open questions

- Does the trigger door write a row when it *refuses* an envelope, and does anything record whether an
  accepted fire produced a turn? `events.ts` is pure; the accept log is in `main.ts`, not read here.
- Whether the stale `users.groups` docblock is a known defect; nothing tests it.
