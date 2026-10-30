# An integration may bring code; one contribution model, and a loader only for code mason trusts

**Status:** Proposed

**Date:** 2026-10-30

**Revisited if:** a second person needs to add an integration without a commit (that is loader 2, named here and not
built), or an integration needs a permission other than "runs as mason", or the contribution surface has to change
without bumping `host`.

ADR-0003 made an integration a service with at most two network faces, and concluded that no extension is written per
integration. ADR-0006 gave an integration a voice, an origin and a reply route, and left the entry promising channels
the code does not have. This decision says what an integration may contribute, where the code that contributes it lives,
and which loader it may use. It does not decide the state channel (issue #62), and it leaves the operator's loader
unbuilt on purpose. The evidence is on `research/connector-mechanism`, in
[`docs/research/connector-mechanism/`](../research/connector-mechanism/INDEX.md).

## What a config entry cannot say

The per-integration surface today is 1,039 lines across four files (`integrations.ts`, `events.ts`, `mcp.ts`,
`integration-status.ts`), and one name is hardcoded in it more than once:

- `src/server/hooks.ts:381` is a 1,623-character instruction that names `mcp__telegram__send_message` and
  `mcp__telegram__send_file` inline, and `:435` is a second one at 1,531 characters for the team chat;
- `src/server/hooks.ts:310` decides where a reply goes with `/\bmcp__[a-z0-9-]+__send_message\b/`, a regex over a tool
  name, because nothing on the entry says it;
- one shipped builtin hook exists that no configuration fires;
- `docs/CONNECTOR-PROTOCOL.md` declares four channels, and the entry can carry two.

The entry has a place for tools and a place for a trigger. It has nowhere to put a prompt section, a reply route, a
row in the reader's transcript, or a lifecycle for a resource the integration owns — the four things ADR-0006 asks for.
Tools are not the gap: every MCP tool registers `deferred` and costs nothing until `tool_search` promotes it, so the
tool channel keeps working exactly as it does and stays the default way to lend an ability.

Those four things cannot arrive from the remote side of a protocol either. MCP's `prompts` are "designed to be
user-controlled", a server may not see the conversation, a notification "MUST NOT" be answered, and the SEP asking for
the server→client direction was closed dormant (SEP-1006). A prompt section is operator-approved text; a protocol that
lets the remote server author it is the one thing ADR-0006 already refuses.

## Decision

### 1. A contribution is a data-first object, validated once

`defineIntegration()` returns `{ name, host, trust, tools, sections, hooks, commands, close() }`, and a single
`install()` validates the closed set at boot and owns the invariants: unique names; section keys outside the reserved
set; tool names through `createMcpToolName`; command words drawn from `COMMAND_NAMES`; every tool registered
`deferred`; one `close()` per resource.

Data first, handlers second. Section text, section key, hook ids, tool names, command words and `host` are values on
the exported object; only the code that runs is a function. That is a mitigation for ADR-0007's objection to loading
anything — `docs/CONNECTOR-PROTOCOL.md` "declare, do not discover" — and it is a mitigation, not an answer: a loader
still learns the contribution list by running the module.

### 2. One loader now: `src/integrations/<name>/`, named in `INTEGRATIONS`

A closed array in code, one line per integration, compiled with the server. A stray file in the directory is dead code
rather than a contribution, which keeps ADR-0007 §6 literally true: there is no directory to drop a file into.

What the loader buys is exactly what the entry cannot say: the section, the reply route, the entry kind and the
`close()`. What it does not buy is a route, a socket, or a word mason does not have. An integration gets no HTTP entry
point (`src/server/auth.ts` is still every way in), may only name command words that already exist in
`COMMAND_NAMES`, and may only *name* an entry kind the projection's whitelist already carries. A new kind, a new
command word or a new route is a mason commit in this repository, whatever loader is involved.

### 3. A loader is not a door: nothing untrusted gets one

The trust boundary is who wrote the code, not where it loads. In-process code is the server, and no mechanism changes
that: pi's own documentation says an extension "can inspect prompts, tool calls, files, credentials, and session
history"; `node:vm` "is not a security mechanism"; a worker thread shares the filesystem, the network and `process.env`;
and Deno states the structural fact — all code on one thread shares one privilege level. `isolated-vm` is not an escape
hatch either: maintenance mode, `--no-node-snapshot`, no module support, and a critical guest→host escape in every
version through 7.0.0.

So a third-party integration keeps today's shape unchanged: out of process, MCP for tools, one signed POST for events,
per ADR-0003. It loses the section, the reply route and the entry kind, and that loss is the price of not trusting the
code. It is written down as a price rather than bought off with a capability table that bounds verbs and not reach —
Claude Code's own documentation concedes that with `Read(.env)` denied "a mod can still read that file with
`$.fs.read`".

The contribution states its provenance: `trust: "first-party" | "operator"`, surfaced in `/api/integrations` and logged
at boot with what it contributed, so nobody infers from a path what a running integration is.

### 4. `prompt.ts` stops being the whole prompt and stays the only renderer

An integration supplies section text and a section key. It never supplies position, order, tagging, the cap or the
sort key: sections sort by integration name and render as one tagged `<key>` block through the same renderer every other
section uses. The pinned section-key test starts pinning the extended list, so a section that appears without an owner
still fails a test.

A section that throws keeps its previous text and is reported — pi-durable's own rule for a failing section, and the
right failure for a prompt: the prefix goes stale instead of going broken.

### 5. `host` is the fourth version number

Mason has three: the event envelope's `v` (a hard refusal, implemented), `AgentService`'s `version: 1` (gated in the
vendored library, no adapter passed, so any bump breaks a stale browser bundle) and `PROTOCOL_VERSION` (closes the
link). An integration's API needs a fourth, and it is checked where a contribution is resolved — at boot — not where
bytes arrive.

A contribution declares `host: <integer>`. Newer than the build refuses the boot naming both numbers, in the same voice
as the envelope's refusal. Unknown *keys* inside a contribution are tolerated, the way v1 envelopes already grow, so
additive change within one `host` is free. A change to the contribution surface bumps the number and the bump is the
whole migration story: mason keeps the previous shape behind one adapter for one build, or it refuses. No semver
ranges — a range can sit silently off for two years and then misfire on a minor line.

### 6. Loader 2, named and not built

When a second person writes an integration, the operator's code lands in `service/integrations/<name>/` and is named by
a `module` field on that integration's entry in `service/integrations.json`: a path confined to `service/integrations/`
and imported at boot, exactly once, exactly that path. No glob, no second list file, no runtime install, no reload.

Two facts make that placement the safe one rather than merely the tidy one. `service/` is service-owned and is never
mounted into the tool machine — the split is a mount boundary, not a file mode — so the bot cannot install its own
capability. And the module failing to import or throwing in its factory is configuration naming code this build cannot
use, which refuses the boot, distinct from a service being down.

Loader 2 is also the one thing that would break ADR-0007 §6's sentence "a directory glob is not a list". Nothing in
this decision breaks it today: loader 2 is not built, so ADR-0007 stands unamended, and the sentence gets amended when
it is, with the reason attached.

### 7. What is core, and what a file may switch off

- A service-backed integration stays optional by default: a container that is down removes its tools, says so in one
  line and in `/api/integrations`, and the boot carries on (ADR-0003, unchanged).
- A contribution the bot cannot be allowed to lack is a compile-time floor. A file may name it; a file may not remove
  it. The chat's reply route is the case that will happen first.
- A module that cannot load refuses the boot. A half-loaded integration is a bot that looks alive and cannot answer.

## The three sentences this settles

**1. `CONNECTOR-PROTOCOL.md` promises a refusal the code does not perform, and the code is what gives way.** The doc
says "an entry that uses `state` or `reply` without a mason that knows them refuses the boot with the field's name, which
is the same refusal a bad hook name gets today". It does not: `validate()` (`src/server/integrations.ts:174-179`)
spreads every unknown key through, so writing `"reply": "send_message"` today is accepted, ignored and preserved. A
credential-shaped key that is silently ignored is worse than one that is refused. The entry's key set becomes closed:
the two implemented faces (`tools`, `trigger`), the switch (`enabled`), the prose (`description`) and the declared
words (`commands`) are read; `state`, `reply` and `also` — declared by the contract and unimplemented by this build —
refuse the boot with the field's name; anything else refuses with the field's name too.

**2. ADR-0003 and ADR-0006 disagree, and ADR-0006 supersedes ADR-0003 in part.** ADR-0003 concluded that "No extension
is written per integration. The only per-integration artefacts are a container, a config entry and a secret", and
ADR-0004 extended that list with a hook. ADR-0006 then gave every entry an operator-authored prompt paragraph and a
`state` list without ever marking ADR-0003 as superseded. The reading this decision adopts: ADR-0003 still governs every
integration mason does not trust — a container, an entry, a secret and a hook, no code — and ADR-0006 and this ADR
govern what a trusted contribution may add. The two status lines say so.

**3. `CAPABILITY-PLAN.md` and ADR-0007 are not in conflict, because they name different things.** CAPABILITY-PLAN's
"every bot has them" is about mason's own capabilities; ADR-0007's "nothing optional is on" is about choosing those per
bot. An integration is neither: it is a peer with its own switch (`enabled`), and §7 above answers core-versus-optional
for it without a `capabilities.ts`. That file remains unbuilt and this decision does not appeal to it.

One more, because this decision has to name the thing: the noun is **integration**, single. The code says it
(`Integration`, `integrations.json`, `/api/integrations`) and `GLOSSARY.md` says it, with "connector" listed as a word to
avoid. `docs/adr/0006-connectors-are-full-duplex-peers.md` and `docs/CONNECTOR-PROTOCOL.md` use "connector", the
research branch uses it throughout, and that
is how one mechanism ended up with two nouns and two ADRs that disagree. New code in this decision is
`defineIntegration()`, `src/integrations/`, `service/integrations/`. Renaming the proposed protocol document is a
follow-up, not part of this decision.

## Alternatives considered

- **A alone: in-tree only, forever.** Keeps ADR-0007 literal and is cheap to review. It loses the operator path, and
  Home Assistant shows what in-tree-only scaling costs an author: a manifest read before the code loads, features found
  by file name, a quality scale with a Bronze floor, hassfest in CI, a deprecation floor measured in months, and a repo
  whose real gate is reviewer time. Rejected as the destination, but this is what ships first, so it is not rejected as
  a step.
- **B alone: boot-loaded only, as pi does it.** Would force first-party code — the reply floor, the chat that must
  always work — to wear the untrusted story and pay pi's costs: an extension load error exits the process, and there is
  no version gate at all. Rejected: mason's floor cannot live behind an unreviewed module.
- **C alone: a richer protocol.** The strongest-sounding option and the weakest in the evidence. MCP carries tools, and
  its other server primitives divide by who controls them; the revision after the one this was checked against removed
  sessions and server-initiated requests and deprecated sampling, logging and roots. An integration built on MCP's
  client-facing half is built on a shrinking surface. What C keeps is the process boundary, and that is exactly what an
  untrusted integration needs.
- **Sandbox the untrusted code in-process.** No mechanism in Node gives a module its own privilege level, and the one
  product that claims to has a critical escape and no module support. A sandbox that does not sandbox is a capability
  table that bounds verbs and not reach.

## Consequences

- `hooks.ts` loses both chat instructions and `DELIVERY_TOOL_NAME`; the reply route becomes a value on the entry.
  `delivery.ts` keeps its two turn-shaped jobs: refuse a nested delivery, never replay one after a restart.
- `CONNECTOR-PROTOCOL.md`'s four channels become: two today (events, tools), one with this decision (reply), one never
  promised here (state, issue #62 — a mason commit with a new principal whatever loader wins).
- Issues #60 and #61 become implementable without touching `src/server/` per vendor; #62 is unblocked by nothing here.
- A restart is the only way to change a contribution, and nothing reloads one mid-conversation. A restart already
  re-dials every integration's MCP face once, so code and tools cannot disagree about which build is running.
- A 400–600-character section costs 106–156 tokens per turn at ADR-0007's chars/4 divisor, 121–178 at pi-ai's 3.5,
  plus the `<key>` frame and the join; a promoted medium MCP tool costs about as much. Sections are the cheap thing,
  promoted tools are the expensive one.
- Not measured, and not to be quoted as if measured: lines of code for the contribution API, and the schedule to land it.
- The state channel stays exactly as it is: no integration principal exists on the Chord remote, and this decision does
  not add one.
