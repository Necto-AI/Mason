# Which mechanism should let a mason connector add code to mason?

## Short answer

Take **D, the hybrid** — but draw the trust boundary at *who wrote the connector*, not at *where it
loads*, and refuse to build the third tier rather than sandbox it. One contribution model: a connector
declares an object whose fields are tools, prompt sections, hook definitions, command names and a
`close()`, validated once by a registry that owns the invariants. Two loaders: `src/connectors/<name>/`,
named in a closed array and compiled with the server, for the connectors mason ships; and
`service/connectors/<name>/`, imported at boot by an explicit path named in a service-owned file, for
what the operator writes. Code mason does not trust gets neither loader and stays where it is today —
out of process, MCP for tools and a signed POST for events — because Node has no per-module privilege
boundary to give it anything more, and every isolation option either was disqualified or is already a
process ([71](https://docs.deno.com/runtime/fundamentals/security/), [69](https://raw.githubusercontent.com/laverdet/isolated-vm/main/README.md)).

Three findings decide it.

**The gap is not tools.** A connector's tools already cost nothing until used, because every MCP tool is
`deferred` and `tool_search`'s description is frozen so the deferred set cannot move the prefix
([2](file:///home/denis/dev/mason/src/server/mcp.ts), [34](file:///home/denis/dev/mason/vendor/pi/packages/durable/src/tool-search/tool-search.ts)).
What a config entry cannot supply is everything else a chat connector needs: an operator-approved prompt
section, a declared reply route, a row in the reader's transcript, a lifecycle for a resource it owns.
MCP carries the first of those four at most, and carries it with the wrong author — `prompts` are
"designed to be user-controlled" ([74](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts.md))
while mason's rule is that prompt text is "injected once per turn, from the file, never from the remote
server" ([17](file:///home/denis/dev/mason/docs/adr/0006-connectors-are-full-duplex-peers.md)).

**The rule that looks like it forbids the second loader forbids something narrower.** Issue #16 rejected
"a loader means dynamic `import()` of arbitrary paths inside the server process, which is a plugin system
with the server's own privileges" ([22](https://github.com/DenisSud/mason/issues/16)), and the
stated reasons are runtime install and a tool list that moves mid-conversation — not a boot-time import
of a module somebody chose. But ADR-0007 goes further and rejects a plugin directory "imported at boot"
on the ground that "a directory glob is not a list — you cannot read the menu without running the code"
([18](file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md)). The
recommendation breaks that sentence for the operator loader and keeps it for the first-party one; §
"Which invariants this holds" says so line by line rather than burying it.

**No isolation mechanism substitutes for review, so the loader must say what it is.** pi states it
flatly: "An extension runs inside the Pi process with the same operating-system permissions. It can
inspect prompts, tool calls, files, credentials, and session history, so load extensions only from
sources you trust" ([27](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/security.md)).
Claude Code is the most developed attempt to escape that sentence without leaving the process, and the
evidence is that its capability table bounds *verbs*, not *reach*: `$.fs` reads "An absolute path [is]
used as given; where one may go is an `fs.*` hook's to say"
([47](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts)),
Anthropic's own doc concedes the gap — with `Read(.env)` denied, "a mod can still read that file with
`$.fs.read`" — and an independent test read `~/.claude/.credentials.json` and POSTed it off the machine:
"No prompt appeared. No permission was asked" ([46](https://code.claude.com/docs/en/plugins/mods/admin.md),
[48](https://pluto.security/blog/claude-code-function-hooks-security/)),
and the guard that protects managed configuration is itself a mod that only loads on managed machines
([46](https://code.claude.com/docs/en/plugins/mods/admin.md)). Copy its manifest containment
and the *enumerability* of its capability table; do not copy the promise.

**Sequence.** Ship the first-party loader and the contribution API now — that is where today's pain is,
and it retires hardcoded vendor names out of `src/server/` ([23](https://github.com/DenisSud/mason/issues/60),
[24](https://github.com/DenisSud/mason/issues/61)). Add the boot loader when a second person writes
a connector, behind the `host` gate in § "Versioning" and the `trust: operator` field, and not before:
with one operator and a handful of connectors the second loader is the expensive half of D, and nothing
in the evidence says mason has to pay for it yet.

## Which invariants the recommendation holds, and which it breaks

The twenty-two rules stated in the invariant notes, compressed into twenty rows and checked against D.
"Strained" means the mechanism can satisfy the rule but only by adding a constraint nothing in the repo
states yet.

| Rule (source) | D |
|---|---|
| R1 prefix byte-identical between two turns of one build ([1](file:///home/denis/dev/mason/src/server/integrations.ts):22-23) | **Holds.** Contributions resolve at boot; sections are keyed and rendered by `prompt.ts`; health stays out. |
| R2/R3 tool surface and sections resolved at boot, tools deferred ([2](file:///home/denis/dev/mason/src/server/mcp.ts):5-6, [1](file:///home/denis/dev/mason/src/server/integrations.ts):12-13) | **Holds.** A connector's tools register `deferred`, so a boot resolves them and a turn pays nothing. |
| R4 sorted render, two renders of one file are the same bytes ([3](file:///home/denis/dev/mason/src/server/prompt.ts):93-94) | **Holds.** Connector lines and sections sort by connector name. |
| R5 one owner per section, declared in `prompt.ts`, "this list is the whole prompt" ([3](file:///home/denis/dev/mason/src/server/prompt.ts):8-9) | **Strained.** `prompt.ts` stops being "the whole prompt"; it becomes the only renderer of a list that a manifest extends. The pinned section-key test ([12](file:///home/denis/dev/mason/test/prompt.test.ts)) must start pinning the extended list instead of the built-in one. |
| R6 prompt text operator-authored, never from the remote server ([17](file:///home/denis/dev/mason/docs/adr/0006-connectors-are-full-duplex-peers.md):35) | **Holds in substance, weaker in form.** First-party text is reviewed code; operator text is a module the operator installed, so it is theirs but no longer a 600-character field they can read. |
| R7/R8 selection repaired on open, `delivery` unconditional ([4](file:///home/denis/dev/mason/src/server/runtime.ts):411-412, :42-43) | **Holds.** Connector contributions are not per-conversation selections, and `delivery` stays in the base set. |
| R9/R10 split home as a mount boundary; enablement service-owned ([5](file:///home/denis/dev/mason/src/server/house.ts):26-28, [1](file:///home/denis/dev/mason/src/server/integrations.ts):9-10) | **Holds — and is why the second loader lives in `service/connectors/`, not `agent/`.** The connector's own file is unreadable to a tool, so a bot cannot install its own capability. |
| R11 every way in goes through `auth.ts` ([21](file:///home/denis/dev/mason/AGENTS.md):30) | **Holds.** A connector gets no route and no socket; if something must reach it, it goes through the HMAC trigger that already exists. |
| R12/R13 closed command set; every caller spends from a stated budget ([6](file:///home/denis/dev/mason/src/server/events.ts):55-56, [7](file:///home/denis/dev/mason/src/server/limits.ts):6-7) | **Holds**, because a connector may only name words from `COMMAND_NAMES` and its hook inherits the door's budget. |
| R14 projection is a whitelist ([8](file:///home/denis/dev/mason/src/server/projection.ts):4-7) | **Broken by design, for entry kinds.** A connector may name an entry kind; it may not add one. Adding a kind is a mason commit in both loaders — the mechanism cannot buy that. |
| R15 one bot, one home, one conversation ([16](file:///home/denis/dev/mason/docs/adr/0004-mason-is-a-headless-backend.md):10) | **Holds.** |
| R16 a capability a bot cannot be allowed to lack is not optional-by-config ([20](file:///home/denis/dev/mason/docs/CAPABILITY-PLAN.md):26-27) | **Holds.** First-party connector contributions that the bot cannot do without (a chat's reply route) stay in the compile-time base set; a file may name them, not remove them. |
| R17 no runtime install ([22](https://github.com/DenisSud/mason/issues/16)) | **Holds.** Nothing is installed after boot. |
| R18 no config file listing which compiled-in code is on ([22](https://github.com/DenisSud/mason/issues/16)) | **Strained.** First-party selection is an array in code that a file may name — ADR-0007's own reconciliation. The operator loader's file names *paths*, which is not "ids from a closed catalog". |
| R19 catalog closed, "no directory to drop a file into" ([18](file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md):258) | **Holds for loader 1, broken for loader 2.** The recommendation is that this is the one sentence Denis is being asked to redline. |
| R20 off restores the prompt byte-for-byte and leaves nothing behind ([18](file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md):267) | **Holds.** Selection is read at boot; removing an entry removes its section, its tools and its module from that boot. |
| R21 broken optional service degrades, broken configuration refuses the boot ([2](file:///home/denis/dev/mason/src/server/mcp.ts):16-18, [4](file:///home/denis/dev/mason/src/server/runtime.ts):442) | **Holds, and it is the rule that decides the failure mode.** A module that fails to load is configuration naming code this build cannot use, so the boot refuses; its MCP endpoint being down is still one line and `/api/integrations`. |
| R22 declare, do not discover ([19](file:///home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md):38) | **Strained.** A loader learns the contribution list by running the module — the exact objection ADR-0007 raises. Mitigation, not full answer: everything that can be data (name, section text, tool names, command names, `host`) is data on the exported object, and only handlers are functions. |

The two strains worth naming for the ADR are R19 and R22. They are the price of the second loader, and
they are payable once or not at all.

## What a connector may contribute, and what mason must keep

The surface has to be a closed list, because mason's problem is not "connectors want to do too much" —
it is that per-connector knowledge leaks into the server when there is no place for it to live.
Today that leak is measurable: `hooks.ts` carries a 1,522–1,623-character instruction naming
`mcp__telegram__send_message` inline, one shipped builtin hook that no configuration fires, a delivery
rule the prompt had to make vague because it could not be true, and a regex
`/\bmcp__[a-z0-9-]+__send_message\b/` standing in for "where the answer goes"
([9](file:///home/denis/dev/mason/src/server/hooks.ts),
[10](file:///home/denis/dev/mason/src/server/extensions/delivery.ts)). The mechanism's job is to
give each of those a declared home.

| May add | What it mutates | When it takes effect | What mason must own |
|---|---|---|---|
| **Tools** | The extension's tool map, then the offered set | Boot; every tool `deferred`, so a turn pays only after `tool_search` promotes it ([2](file:///home/denis/dev/mason/src/server/mcp.ts)) | The name (`createMcpToolName`'s 64-char cap and digest), the deferred flag, the offered list's order |
| **Prompt sections** | The rendered system message, as one tagged `<key>` block | Every turn, from text fixed at boot | The renderer, the order, the cap, the sort key. A connector supplies text and a key; it never supplies position |
| **Hook definitions** | `HooksManager`'s hook table | Boot, before the first fire | The trigger vocabulary, the template variables, the fire identity and dedupe, the budgets |
| **Command names** | Nothing new: a subset of `COMMAND_NAMES` | Boot; dispatch unchanged | The whole vocabulary and its dispatch. A connector may not add a word: "a closed set, because every name here is a method the console can call too" ([6](file:///home/denis/dev/mason/src/server/events.ts)) |
| **Entry kinds in the projection** | Nothing. It may *name* a kind that exists | Per turn | The whitelist and the wire union. "a new entry kind or a new tool cannot leak by default — it is invisible until this file says so" ([8](file:///home/denis/dev/mason/src/server/projection.ts)) |
| **Ingest work** | Its own resource only, through a scoped handle with a `close()` | Inside a fire, or inside a tool call | The door, the signature, the fence, the fire budget, and the unwind list that closes what it opened ([4](file:///home/denis/dev/mason/src/server/runtime.ts)) |
| **Reply routing** | Its entry's declared reply tool, replacing the name-shaped regex | Boot | That the answer lands somewhere, once, and that a hooked turn cannot be answered through a channel that cannot arrive |
| **State subscriptions** | Nothing today: no connector principal exists on the Chord remote | — | The whole channel. Not offered, and not promised. Issue #62 is a mason commit whatever the loader is ([25](https://github.com/DenisSud/mason/issues/62)) |

Two things a connector must never be able to do, and both are load-bearing rather than stylistic. It may
not write its own enablement: the file is "service-owned (`service/integrations.json`), never a path
inside `agent/`: a tool that could rewrite its own capability is not a capability a person chose"
([1](file:///home/denis/dev/mason/src/server/integrations.ts)). And it may not put its own
words in the system prompt as though the operator had approved them — the one thing ADR-0006 already
refuses, and the reason the operator loader's sections must be read from the connector's own file, not
from a tool result.

## Where the code lives, and why the other placements lose

**A alone — in-tree only.** Cheapest to review and the only placement that keeps R19 literally true: a
connector is a directory under `src/connectors/` plus one line in the `CONNECTORS` array, and a stray
file is dead code rather than a contribution. Home Assistant is the reference: its manifest is read
before any of the integration's code loads ([50](https://contributors.home-assistant.io/core/integrations/manifest/)),
features are found by file name, "Home Assistant finds most features of an integration by file name, so the names below
matter" ([51](https://contributors.home-assistant.io/core/integrations/file-structure/)),
and out-of-tree integrations are "built the same way, with two differences in the manifest"
([57](https://contributors.home-assistant.io/core/integrations/create/)). It loses on the thing
Denis actually asked for: the operator cannot add a connector without a commit, and HA shows what
in-tree scaling costs — a 54-rule quality scale beside every integration, a Bronze floor no new
integration may sit below ([53](https://contributors.home-assistant.io/core/quality-scale/)), hassfest in CI, a 6/12-month
deprecation floor, and a repo whose gate is reviewer time
([55](https://contributors.home-assistant.io/core/quality-scale/rules/),
[54](https://contributors.home-assistant.io/core/quality-scale/quality-scale-file/),
[56](https://contributors.home-assistant.io/core/development/deprecating/)).

**B alone — boot-loaded only.** This is the shape pi uses: a module loaded by jiti from a directory
([29](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/loader.ts)),
and pi pays for it with the honest warning quoted above, a boot that exits 1 on any extension load error
([30](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/main.ts)), and no version gate
at all — nothing declines to load a module for having been written against an older API. It also pays
in surface: 41 lifecycle event handlers, four kinds of renderer, providers, virtual models, CLI flags,
shortcuts and an MCP registry, enumerated from the API's own types
([26](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/extensions.md),
[28](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/types.ts)).
Copying pi wholesale is not a plan for a host with one conversation; copying its loader and its
validated registry is. Mason cannot put its own reply floor and its
own chat connector behind an unreviewed module — R16 and R8 exist exactly to stop that — so B alone
forces first-party code to wear the operator's trust story.

**C alone — richer protocol.** This is the strongest-looking option and the weakest in the evidence.
MCP 2025-11-25 carries tools, and the rest of its server primitives divide by who controls them: prompts
and resources are user- or application-controlled ([74](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts.md),
[75](https://modelcontextprotocol.io/specification/2025-11-25/server/resources.md)); a
server may not read the conversation, because "Servers should not be able to read the whole
conversation, nor 'see into' other servers"
([76](https://modelcontextprotocol.io/specification/2025-11-25/architecture/index.md)); a
notification "MUST NOT" be answered ([72](https://modelcontextprotocol.io/specification/2025-11-25/basic/index.md));
and the SEP that asked for the one direction mason needs was closed dormant — "Since this has not found
a sponsor since July. I will close this for now" ([77](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1006)).
It also loses in the other direction: the revision after the one this brief nominates removed sessions
and server-initiated requests and deprecated sampling, logging and roots
([78](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)), so a
connector built on MCP's client-facing half is built on a shrinking surface. What C keeps is exactly
what a connector needs when mason does not trust it: a process boundary and a protocol.

**D — one manifest, two loaders.** It wins because the trust difference is real and gets stated rather
than engineered: `trust: "first-party"` is code reviewed in the server's own PR, `trust: "operator"` is
a module in `service/connectors/` the person who owns the box put there, and both are "runs as the
server". The cost is one manifest, one registry, and one closed contribution list for two loaders — which
is the same object, built by the same `defineConnector()` and validated by the same `install()`, in the
shape pi-durable already demonstrates: an extension is a "Named bundle of code; installed in a registry
and selected by conversations by name" whose validation is a cheap closed set — "Unique tool names and
section keys within one extension; valid, unreserved section keys"
([31](file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/types.ts),
[32](file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/registry.ts)).

## Loading, lifecycle, and the byte-identical prefix

**Resolved once, before the first turn.** The loader runs at boot, in the order `CONNECTORS` declares,
then the operator modules, and the contribution list is frozen for the process's life. That is not a
convenience, it is the rule the whole design answers to: "Health is server state and never a prompt
section: it varies between turns, and the resident prefix must be byte-identical between two turns of one
build" ([1](file:///home/denis/dev/mason/src/server/integrations.ts)). It is also what pi-durable
already does for sections, since its
system-entry planner writes only the minimal diff — "A section that throws keeps its shown text, if any,
and is reported" ([33](file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/prompt.ts)).
A throwing connector section therefore cannot corrupt the prefix; it goes stale and is reported, which is
the right failure for a prompt.

**A restart is the only change.** Nothing reloads a connector mid-conversation, and mason exposes no
method that would let one ask — there is no analogue of pi's `/reload`, which is a person's gesture in a
CLI. What a restart means for the network face is already fixed: one attempt per server at boot,
"because mason and an integration's container usually restart together"
([2](file:///home/denis/dev/mason/src/server/mcp.ts)). A connector's code and its tools restart in that
same process, so the two cannot disagree about which build is running.

**Mid-turn there is nothing to do.** Connector code runs in exactly three places: a tool call, a hook
fire, and a section render. None of them is between the tool list and the request; all three are inside
a turn that has already been priced.

**A bad connector refuses the boot.** Not quarantined, not partially loaded, and not retried. Three
neighbouring answers exist and mason should take none of them. Claude Code drops the bad component and
lets the plugin "load without that component"
([42](https://code.claude.com/docs/en/plugins/loading.md)) — coherent for a host that must keep a
person's editor usable. Home Assistant hands the failure to the host and retries it: "You do not write
retry loops for that: you raise the right exception, and Home Assistant does the rest"
([52](https://contributors.home-assistant.io/core/integrations/setup-failures/)) — coherent for a host
with a config-entry state machine, which mason does not have. And pi exits 1
([30](file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/main.ts)) — which is mason's own
precedent: an entry naming a hook the build does not define "must refuse rather than start"
([4](file:///home/denis/dev/mason/src/server/runtime.ts)), and a command word this build does not have
names the whole set it should have been drawn from
([1](file:///home/denis/dev/mason/src/server/integrations.ts)). A half-loaded connector is a bot that
looks alive and cannot answer — near enough the failure `CAPABILITY-PLAN.md` names when it refuses to
make transcription and search optional, "a new bot would be born mute, blind and unable to look anything
up" ([20](file:///home/denis/dev/mason/docs/CAPABILITY-PLAN.md)).

**A service down is still just one line.** The MCP face keeps its current behaviour exactly: "Nothing
here is fatal by default. A container that is down removes its tools, says so in one line and in
`/api/integrations`, and the boot carries on" ([2](file:///home/denis/dev/mason/src/server/mcp.ts)).

## Trust: the loader is not the door

In-process code is the server. pi says it, HA's loader behaves that way — a custom integration with the
same domain as a built-in one overrides it ([51](https://contributors.home-assistant.io/core/integrations/file-structure/))
— and Node gives no way to make it otherwise: `node:vm` "is not a security mechanism. Do not use it to
run untrusted code" ([66](https://nodejs.org/api/vm.md)); a worker thread contains a hang and a
throw and, approximately, the heap, but not the filesystem, the network or `process.env`
([67](https://nodejs.org/api/worker_threads.md)); `child_process` makes no isolation
claim at all ([68](https://nodejs.org/api/child_process.md)); and Deno states the
structural fact that kills per-module privilege — "All code executing on the same thread shares the same
privilege level. It is not possible for different modules to have different privilege levels within the
same thread" ([71](https://docs.deno.com/runtime/fundamentals/security/)).

So the design puts the weight where mason already carries it, and adds one field:

- **The door is the file's owner.** `connectors.json` and `service/connectors/` are service-owned and
  outside the tool machine's mount, which is mason's actual privilege mechanism, not a file mode — "The
  split is a mount boundary, not a permission mode: `bash` can talk its way around a mode"
  ([5](file:///home/denis/dev/mason/src/server/house.ts)).
- **The entry states its provenance.** `trust: "first-party" | "operator"`, surfaced in
  `/api/integrations` and logged at boot, so nobody has to infer from a path what a connector is.
- **Nothing third-party gets a loader.** If a connector needs a permission story other than "as mason",
  its answer is C: it stays a process, and it loses the prompt section, the reply route and the entry
  kind. Home Assistant draws the same line in the same place and says what the operator loader costs an
  author: "Everything shared this way is made and supported by you, not by the Home Assistant project"
  ([58](https://contributors.home-assistant.io/marketplace/)). That loss — a prompt section, a reply
  route, a transcript row — is the price of not trusting the code, and it should be written down as a
  price rather than bought off with a capability table that bounds verbs and not reach.
- **If isolation is ever required, name the mechanism and what it contains.** It is a process — a second
  user, a namespace, or a container — and then the connector is C again, with a protocol to carry what
  code would have carried. `isolated-vm` is not that mechanism: it is in maintenance mode, needs
  `--no-node-snapshot`, has no module support, and shipped a critical-severity guest→host escape in
  every version through 7.0.0 — "a guest that holds a single `ivm.Reference` can obtain the
  `ExternalCopy` constructor and trigger the bug, so this breaks isolated-vm's core guest/host boundary"
  ([70](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4)).

What Claude Code's table *is* good for is worth separating from what it is sold as. Its real achievement
is enumerability: a hook reaches the outside world only through the capability table, so "A hook has no
other way to do those things, which is why Claude Code can [list what a mod does] before you install
it" ([43](https://code.claude.com/docs/en/plugins/mods/overview.md)), and that list is produced by
reading the module's source against rules that make a capability un-hideable
([45](https://code.claude.com/docs/en/plugins/mods/create.md)). Enumerability is a review aid, and mason
should have it — a connector's boot diagnostic should print the sections, tools, hooks and commands it
contributed. It is not a boundary: a policy hook that throws fails open, reproduced independently when a
hook was cut at its ten-second budget and "`echo hi` ran anyway"
([49](https://aidive.dev/club/free-resources/claude-code-mods/)).

## Versioning a surface that changes

Mason has three version numbers today and no host-API version. The envelope's `v` is a hard refusal:
anything but the integer 1 returns `{ error: '"v" must be the integer 1' }`, the route answers 400 and
fires nothing, and the file's own comment calls an unknown version "a sender's bug, refused rather than
guessed at" ([6](file:///home/denis/dev/mason/src/server/events.ts), [13](file:///home/denis/dev/mason/test/events.test.ts)).
`AgentService` carries `version: 1` and the gate lives in the vendored library, which offers three
outcomes — bind, bind through an `accepts` adapter, or throw `contract_mismatch` — and mason passes no
adapter anywhere, so any bump is a hard break for a stale browser bundle
([36](file:///home/denis/dev/mason/vendor/pi/packages/chord/src/contract.ts),
[14](file:///home/denis/dev/mason/src/web/client.ts)). `PROTOCOL_VERSION = 4` gates the link and
its answer to a mismatch is to close it ([37](file:///home/denis/dev/mason/vendor/pi/packages/chord/src/wire.ts)).
A fourth number is needed, and the ADR should say plainly that it is a fourth: it gates the connector
API, so it must be checked where a connector is resolved — at boot — not where bytes arrive.

The shape to copy is mason's own, not VS Code's. A connector manifest declares `host: <integer>`. A
`host` newer than the build refuses the boot naming both numbers, in the same voice as the envelope's
refusal and the command-set refusal — and VS Code's wording is worth stealing for it: `Extension is not
compatible with Code {0}. Extension requires: {1}.`
([60](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/extensions/common/extensionValidator.ts));
unknown *keys* inside a contribution are tolerated, the way v1
envelopes already grow ("unknown fields are ignored, so v1 grows",
[19](file:///home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md)). Additive change within
one `host` is free; any change to the contribution surface bumps the number and the bump is the whole
migration story — mason keeps the previous contribution shape behind one adapter for one build, or it
refuses. Reject semver ranges. A range gate can be silently off for two years and then misfire on a
minor line ([64](https://grafana.com/whats-new/2025-05-05-enforcing-stricter-version-compatibility-checks-in-plugin-cli-install-commands/),
[65](https://github.com/VictoriaMetrics/victoriametrics-datasource/issues/462)). Chrome's version field
turned out to be irrelevant to the only forced migration it ever ran, because MV3 was not expressible as
a range at all ([62](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline)).
And Chrome's minimum-version floor fails silently for everyone already installed: "Existing users of your
extension won't receive updates when the `minimum_chrome_version` is higher than their current browser
version. This happens silently"
([63](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)).
Claude Code, meanwhile, has no host-API field at all: reading its complete manifest field table leaves a
plugin version that pins users and plugin-to-plugin dependency ranges, and nothing that names the build
a plugin was written against ([40](https://code.claude.com/docs/en/plugins/manifest-reference/)) — an
absence the notes record as their reading of a complete table, not a sentence Anthropic wrote.
VS Code's decade of evidence reads the other way — `engines.vscode` plus a proposed tier, a stable
surface that has never shipped a 2.0, and 30 `@deprecated` members not one of which has been deleted
([61](https://code.visualstudio.com/api/advanced-topics/using-proposed-api),
[59](https://code.visualstudio.com/api/references/extension-manifest)) — but that
evidence is about a host that chose to freeze, which is the opposite of a host with a handful of
connectors and one operator.

One piece of machinery already exists and should be used rather than rebuilt: pi-durable's stored-record
gate has exactly the semantics a connector's persisted state needs — a newer stored version is an error,
an older one requires a migration — and mason calls it nowhere
([35](file:///home/denis/dev/mason/vendor/pi/packages/durable/src/documents.ts)).

## Migration order

Nothing is retired in this pass; the order matters because each step removes one hardcoded vendor fact
from `src/server/`.

1. **Land the manifest and the registry, with loader 1 only.** `defineConnector()`, `install()`'s
   validation, the closed `CONNECTORS` array, sections rendered by `prompt.ts` in sorted order, and
   `host` checked at boot.
2. **Move Telegram's knowledge into `src/connectors/telegram/`.** The person-chat template out of
   `hooks.ts` and into the connector's declared section (issue #61), the reply tool out of
   `DELIVERY_TOOL_NAME` and into the entry's declared route (issue #60), the two hand-copied vendor
   shapes in `mcp.ts` into whatever the connector actually needs.
3. **Keep `integrations.json` for the two faces that need no code.** `tools.url`, `tools.required`,
   `trigger.hook`, `trigger.secret` and `description` keep their meaning; the file stops being the only
   place a connector exists. Nothing about the HMAC door, the envelope, the fence or the budgets changes.
4. **Keep `commands` exactly as it is.** The vocabulary stays closed in `events.ts` and the boot refusal
   stays where it is; a connector's manifest may only name words that already exist. This is the one
   place where "connectors declare, mason decides" is already implemented and should not be revisited.
5. **Add loader 2 last**, with `service/connectors/`, `connectors.json`, `trust: operator`, the `host`
   gate, and a boot refusal on any import or factory error.

## The cost, per candidate

| | A: in-tree | B: boot-loaded | C: process (today) | D: both loaders |
|---|---|---|---|---|
| Prefix tokens per connector | 106–156/turn for a 400–600-char section at mason's chars/4, 121–178 at pi-ai's 3.5 ([18](file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md), [38](file:///home/denis/dev/mason/vendor/pi/packages/ai/src/utils/estimate.ts)) | same | ~10 for the description line + 87 for `tool_search`, then 46–153 per promoted tool, paid for the rest of the conversation | A's figure for first-party, B's for operator |
| Containers | none | none | one per connector, plus a restart story | none |
| Review burden | one file per connector, in the server's PR | an unreviewed module the server executes; Claude Code's warning is exact — "the files you reviewed can change on disk" ([41](https://code.claude.com/docs/en/plugins/security.md)) | the server's own repo, out of tree | both, separated by the `trust` field |
| What a person learns to add one | the manifest, the closed contribution list, `host` | same | the envelope, HMAC, budgets, MCP, plus a reply convention that only exists as prose | the manifest first, the file layout second |
| Lines of mason today | the per-connector surface is 1,039 lines across four files ([1](file:///home/denis/dev/mason/src/server/integrations.ts), [6](file:///home/denis/dev/mason/src/server/events.ts), [2](file:///home/denis/dev/mason/src/server/mcp.ts), [11](file:///home/denis/dev/mason/src/server/integration-status.ts)) | — | — | — |

The token comparison is the one number that should change Denis's mind either way, and it points at a
different conclusion than expected: **a connector section is cheap.** At 400–600 characters it costs
about what promoting one medium MCP tool costs, and less than promoting two — so a connector that needs
its own words in the prompt is not the expensive thing; a connector whose *tools* get promoted is. That
is an argument for keeping the MCP face as the default tool channel and for making sections the thing
code buys. It is also why the same connector should not have both a section and eagerly-offered tools:
two connectors of the real-world size Anthropic reports — "A typical multiserver setup (GitHub, Slack,
Sentry, Grafana, and Splunk) can consume ~55k tokens in definitions before Claude does any work"
([79](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md))
— would dwarf every section mason will ever write (arithmetic on the two figures, not a measurement).
Claude Code makes the opposite trade and says so plainly: a plugin's names and descriptions count toward
usage "even in sessions where nothing from the plugin runs"
([39](https://code.claude.com/docs/en/plugins/overview.md)) — which is exactly what deferral buys mason
and what a connector's section spends deliberately.

Two costs are not measured and must not be quoted as if they were: the lines of code a contribution API
adds, and the schedule to land it. The notes contain no measurement for either.

## Conflicts in the evidence

**Mason's written contract promises enforcement the code does not perform.** `CONNECTOR-PROTOCOL.md`
says an entry that uses `state` or `reply` "refuses the boot with the field's name, which is the same
refusal a bad hook name gets today", and that a connector built against a newer mason "degrades: it
loses the channels that mason does not have". The code spreads every unknown key through —
`validate()` returns `{ ...raw, enabled, … }` — and there is no branch that could refuse
([1](file:///home/denis/dev/mason/src/server/integrations.ts)). Writing `"reply":
"send_message"` into the file today is accepted, ignored and preserved. Only the envelope's `v` is
enforced. This is the honest answer to the brief's versioning question: mason has one implemented version
gate and one plan.

**ADR-0003 and ADR-0006 disagree about what an integration is.** ADR-0003 concludes that "No extension is
written per integration. The only per-integration artefacts are a container, a config entry and a
secret" ([15](file:///home/denis/dev/mason/docs/adr/0003-integrations-are-services.md)); ADR-0006
gives every entry an operator-authored prompt paragraph and a `state` list, and never names ADR-0003 as
superseded — it says it "finishes the job". A reader cannot tell whether "no per-integration code" still
stands. The mechanism inherits this ambiguity: it is either ADR-0003's answer (there is no code) or
ADR-0006's (there is a section, and sections are prose).

**CAPABILITY-PLAN and ADR-0007 disagree about whether a capability may be off**, and the file that would
settle it does not exist. CAPABILITY-PLAN says capabilities ship in code so "every bot has them"; ADR-0007
says "Nothing optional is on, which is the requirement stated as a default", and proposes
`src/server/capabilities.ts`, which is absent from the tree. A connector mechanism has to answer which of
its contributions are core, and it cannot appeal to an unbuilt file for the answer
([18](file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md),
[20](file:///home/denis/dev/mason/docs/CAPABILITY-PLAN.md)).

**Claude Code's own docs describe two different boundaries and never joined them.** "Mods aren't
sandboxed" and "The hooks module itself has no Node.js APIs, no timer globals such as `setTimeout`, and
no network or file access of its own" are both Anthropic's, forty lines apart, in two pages
([43](https://code.claude.com/docs/en/plugins/mods/overview.md),
[44](https://code.claude.com/docs/en/plugins/mods/api.md)). They are consistent — the *module
context* is capability-stripped, the *process* is not — but a reader who takes the first alone will
overrate what the capability table buys, which is precisely what the independent test found: a mod can
read a credential file and POST it out with no prompt.

**And the guard that protects the host may not be loaded.** The same page says users cannot turn
`sec-default@builtin` off and that it loads only when the machine has managed settings or the session is
on a Team/Enterprise login; it also says any *other* policy hook fails open when it throws
([46](https://code.claude.com/docs/en/plugins/mods/admin.md)). Both statements are Anthropic's,
in one document. The mechanism's trust model must not rest on a guard that a mason install would not
have.

**The versioning evidence supports opposite conclusions.** VS Code's evidence says versioning works: a
decade at 1.x, 30 deprecations, zero. Chrome's says the version field was irrelevant to the only forced
migration it ever ran, because the change was not expressible as a range. Home Assistant's says the real
mechanism is a clock and a repair issue, with no minimum-host-version key visible in its manifest
reference at all. Not a
contradiction in fact; a contradiction in what "protect against drift" means, and the ADR should pick one
and say which.

**The cost divisor is not settled in mason's own tree.** ADR-0007's `promptTokens` divides by 4;
pi-ai's own estimator divides by 3.5 ([38](file:///home/denis/dev/mason/vendor/pi/packages/ai/src/utils/estimate.ts)).
Every token figure above therefore carries a 12–14% band, and the ADR should print the band rather than
one number. ADR-0007's figure is also text-only — it omits the `<key>` frame and the join — so a tagged
section costs ~10% more than the number a person reads there.

**MCP's policy and mason's policy are deliberately incompatible on one point.** The spec says a server
that declared `listChanged` SHOULD send a notification, and its message flow has the client answer with
`tools/list` ([73](https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md)); mason declines,
because "Boot is the only moment this happens, because the tool list is prompt prefix"
([2](file:///home/denis/dev/mason/src/server/mcp.ts)). The mechanism keeps mason's side. Whether that
is expensive is unverified: nobody has measured whether a mid-session `tools/list` refresh would actually
re-price the prefix or only the deferred index, and if it is cheap, one blocker on candidate C softens.

## What remains open

**Whether a boot-time import is forbidden or merely unmentioned.** Nothing in `docs/SPEC.md`, the eight
ADRs, `CONNECTOR-PROTOCOL.md` or `CAPABILITY-PLAN.md` states the boot-import case on its own. Issue #16
rejects runtime install; ADR-0007 rejects a plugin directory imported at boot, but for a reason about
capabilities being first-party. The recommendation sits on the thinner side of a sentence Denis has not
written yet, and that is the decision, not a research question.

**Whether the contribution API can be read as data.** R22's strain is softened, not resolved, by putting
section text and tool names on the exported object. Whether mason could go further — a JSON-only
connector with no code at all for the common case — is not addressed by any source here, and would be the
cheapest possible answer for the operator loader.

**Nothing measured on schedule or size.** No source gives lines of code or time for a contribution API,
and no tokenizer was run for any figure — the notes' numbers are character counts divided by 4 or 3.5.

**Whether a `host` gate would ever fire.** There is no history of a mason connector API changing, so the
gate is insurance, and the evidence for insurance is HA's cost (a 12-month floor and shims shipped in
core) versus VS Code's (a surface it can no longer change).

**`environment 2` remains undefined.** The closest thing Claude Code has to a declared host-API
generation appears in one debug log line, in no page and in no declaration
([47](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts)),
and the only explanation in the corpus is a third party's reading of their own probe logs. Do not treat it
as a version.

**The `state` channel is undecided and is not the mechanism's to decide.** Issue #62 wants a connector to
subscribe to status, projection, presence and tools; the Chord remote has a single owner variant and no
connector principal. Whatever loader wins, that channel is a mason commit with a new principal, and the
mechanism should not promise it.

## Sources

1. `src/server/integrations.ts` — file:///home/denis/dev/mason/src/server/integrations.ts
2. `src/server/mcp.ts` — file:///home/denis/dev/mason/src/server/mcp.ts
3. `src/server/prompt.ts` — file:///home/denis/dev/mason/src/server/prompt.ts
4. `src/server/runtime.ts` — file:///home/denis/dev/mason/src/server/runtime.ts
5. `src/server/house.ts` — file:///home/denis/dev/mason/src/server/house.ts
6. `src/server/events.ts` — file:///home/denis/dev/mason/src/server/events.ts
7. `src/server/limits.ts` — file:///home/denis/dev/mason/src/server/limits.ts
8. `src/server/projection.ts` — file:///home/denis/dev/mason/src/server/projection.ts
9. `src/server/hooks.ts` — file:///home/denis/dev/mason/src/server/hooks.ts
10. `src/server/extensions/delivery.ts` — file:///home/denis/dev/mason/src/server/extensions/delivery.ts
11. `src/server/integration-status.ts` — file:///home/denis/dev/mason/src/server/integration-status.ts
12. `test/prompt.test.ts` — file:///home/denis/dev/mason/test/prompt.test.ts
13. `test/events.test.ts` — file:///home/denis/dev/mason/test/events.test.ts
14. `src/web/client.ts` — file:///home/denis/dev/mason/src/web/client.ts
15. ADR-0003, integrations are services — file:///home/denis/dev/mason/docs/adr/0003-integrations-are-services.md
16. ADR-0004, mason is a headless backend — file:///home/denis/dev/mason/docs/adr/0004-mason-is-a-headless-backend.md
17. ADR-0006, connectors are full-duplex peers (proposed) — file:///home/denis/dev/mason/docs/adr/0006-connectors-are-full-duplex-peers.md
18. ADR-0007, capabilities are listed once in code (proposed) — file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md
19. `docs/CONNECTOR-PROTOCOL.md` (proposed) — file:///home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md
20. `docs/CAPABILITY-PLAN.md` — file:///home/denis/dev/mason/docs/CAPABILITY-PLAN.md
21. `AGENTS.md` — file:///home/denis/dev/mason/AGENTS.md
22. Issue #16, the two rejections — https://github.com/DenisSud/mason/issues/16
23. Issue #60, voice, origin, reply router — https://github.com/DenisSud/mason/issues/60
24. Issue #61, each connector declares a prompt section — https://github.com/DenisSud/mason/issues/61
25. Issue #62, connectors subscribe to the state they render — https://github.com/DenisSud/mason/issues/62
26. pi extension docs — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/extensions.md
27. pi security docs — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/security.md
28. pi `src/core/extensions/types.ts` — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/types.ts
29. pi `src/core/extensions/loader.ts` — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/loader.ts
30. pi `src/main.ts` (boot refusal) — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/main.ts
31. pi-durable `harness/types.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/types.ts
32. pi-durable `harness/registry.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/registry.ts
33. pi-durable `harness/prompt.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/prompt.ts
34. pi-durable `tool-search/tool-search.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/tool-search/tool-search.ts
35. pi-durable `documents.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/documents.ts
36. Chord `src/contract.ts` — file:///home/denis/dev/mason/vendor/pi/packages/chord/src/contract.ts
37. Chord `src/wire.ts` — file:///home/denis/dev/mason/vendor/pi/packages/chord/src/wire.ts
38. pi-ai `src/utils/estimate.ts` — file:///home/denis/dev/mason/vendor/pi/packages/ai/src/utils/estimate.ts
39. Claude Code plugins overview — https://code.claude.com/docs/en/plugins/overview.md
40. Claude Code plugin manifest reference — https://code.claude.com/docs/en/plugins/manifest-reference.md
41. Claude Code plugin security and trust — https://code.claude.com/docs/en/plugins/security.md
42. Claude Code plugin loading reference — https://code.claude.com/docs/en/plugins/loading.md
43. Claude Code mods overview — https://code.claude.com/docs/en/plugins/mods/overview.md
44. Claude Code mods API (`$`) — https://code.claude.com/docs/en/plugins/mods/api.md
45. Claude Code create a mod — https://code.claude.com/docs/en/plugins/mods/create.md
46. Claude Code manage mods for your organization — https://code.claude.com/docs/en/plugins/mods/admin.md
47. `mods/types/claude-code.d.ts` — https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts
48. Pluto Security, "Claude Code Mods Security: 4 Function Hook Risks", 2026-09-22 — https://pluto.security/blog/claude-code-function-hooks-security/
49. AIDive, "Claude Code Mods: the fail-open experiment", 2026-10-07 — https://aidive.dev/club/free-resources/claude-code-mods/
50. Home Assistant integration manifest — https://contributors.home-assistant.io/core/integrations/manifest/
51. Home Assistant integration file structure — https://contributors.home-assistant.io/core/integrations/file-structure/
52. Home Assistant setup failures and exceptions — https://contributors.home-assistant.io/core/integrations/setup-failures/
53. Home Assistant quality scale overview — https://contributors.home-assistant.io/core/quality-scale/
54. Home Assistant quality scale file — https://contributors.home-assistant.io/core/quality-scale/quality-scale-file/
55. Home Assistant quality scale rules — https://contributors.home-assistant.io/core/quality-scale/rules/
56. Home Assistant deprecating — https://contributors.home-assistant.io/core/development/deprecating/
57. Home Assistant, create an integration — https://contributors.home-assistant.io/core/integrations/create/
58. Home Assistant, the Marketplace — https://contributors.home-assistant.io/marketplace/
59. VS Code extension manifest — https://code.visualstudio.com/api/references/extension-manifest
60. VS Code `extensionValidator.ts` — https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/extensions/common/extensionValidator.ts
61. VS Code using proposed API — https://code.visualstudio.com/api/advanced-topics/using-proposed-api
62. Chrome Manifest V2 support timeline — https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline
63. Chrome `minimum_chrome_version` — https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version
64. Grafana, stricter version compatibility checks (2025-05-05) — https://grafana.com/whats-new/2025-05-05-enforcing-stricter-version-compatibility-checks-in-plugin-cli-install-commands/
65. VictoriaMetrics datasource issue #462 — https://github.com/VictoriaMetrics/victoriametrics-datasource/issues/462
66. Node.js VM — https://nodejs.org/api/vm.md
67. Node.js worker threads — https://nodejs.org/api/worker_threads.md
68. Node.js child process — https://nodejs.org/api/child_process.md
69. `isolated-vm` README — https://raw.githubusercontent.com/laverdet/isolated-vm/main/README.md
70. GHSA-864f-rcv7-6rh4 — https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4
71. Deno security and permissions — https://docs.deno.com/runtime/fundamentals/security/
72. MCP specification 2025-11-25, base protocol — https://modelcontextprotocol.io/specification/2025-11-25/basic/index.md
73. MCP specification 2025-11-25, server tools — https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md
74. MCP specification 2025-11-25, server prompts — https://modelcontextprotocol.io/specification/2025-11-25/server/prompts.md
75. MCP specification 2025-11-25, server resources — https://modelcontextprotocol.io/specification/2025-11-25/server/resources.md
76. MCP specification 2025-11-25, architecture — https://modelcontextprotocol.io/specification/2025-11-25/architecture/index.md
77. SEP-1006, bidirectional tool calls — https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1006
78. MCP specification 2026-07-28, key changes — https://modelcontextprotocol.io/specification/2026-07-28/changelog.md
79. Anthropic, tool search tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md
