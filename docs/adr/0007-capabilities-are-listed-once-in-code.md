# A capability is listed once, in code, and chosen per bot

**Status:** Proposed

**Date:** 2026-10-27

**Revisited if:** a capability ever needs a parameter of its own — a URL, a key, a seat — or somebody outside this
repository needs to add one. A capability with a parameter is a service whose credential belongs to a container
(`docs/adr/0003-integrations-are-services.md`) or an integration; an outside party adding one is a plugin system, and this
decision says no to one on purpose.

`docs/CAPABILITY-PLAN.md` decided that mason's own capabilities ship in code rather than in one bot's config, and the
first version of that rule has one hole in it: it says *never configurable* where the operator is now asking for *chosen
per bot*. The failure on one side is noise: a bot pays, every turn, for a transcriber, a widget manual and an OCR it
never uses, and a stack runs a container and 1.3 GB of ONNX graphs for a bot that has no relay. The failure on the other
side is a second implementation per bot: today the way to give one bot a capability is to edit *that bot's* compose file
and *that bot's* home, and work done there is not available to the next bot without being done again.
The requirement, in the operator's words, is a library effect: capability is added to mason once, in code, and each bot
chooses what it needs; nothing is on by default; and nothing about choosing one requires a human hand-editing a config to
"install" it.

The seams for this already exist and are empty. A conversation has a stored extension selection that is repaired at boot
(`src/server/runtime.ts:73-75`, `:322`, `:415-426`); the prompt is a declared list of sections whose text is computed from
boot configuration and omitted when there is none to compute (`src/server/prompt.ts:90-100`, `:130-159`); shipped skills
are copied into the agent's half with a record of what was copied, so a copy that was never edited can be replaced
(`src/server/house.ts:231-274`); every optional service is already a separate compose file rather than a profile
(`deploy/compose.telegram.yaml:9-11`) and the deploy already proves what is running (`deploy/deploy.sh:118-139`). What is
missing is one list that says what a capability *is*, and one file that says what a bot *chose*.

## Decision

### 1. The library is one file, `src/server/capabilities.ts`

```ts
/**
 * One capability: what it is, what it needs, and what it costs. This list is the library — a capability exists when it is
 * here, and a bot chooses from it by id. Nothing here is per bot: the same entry serves every bot that names it.
 */
export interface Capability {
	/** The id `capabilities.json` names. Lowercase, digits and dashes — the same rule as an integration name, because it
	 *  also names a file (`deploy/compose.<id>.yaml`), and the switches a person reads in a diff say the same thing. */
	readonly id: string;
	/** Every bot has it and no file can take it away. It is in the catalog so the per-turn bill is one file, not so that
	 *  there is a switch. */
	readonly core: boolean;
	/** One operator-facing line: what turning this on buys, in the words a person choosing would use. */
	readonly description: string;
	/** pi-durable extensions the conversation selects when this is on. Installed by the boot already — a name this build
	 *  does not have refuses the boot rather than being silently unselectable. */
	readonly extensions?: readonly string[];
	/** Sections of `prompt.ts` this capability owns. A section has exactly one owner; the floor's sections have none. */
	readonly sections?: readonly string[];
	/** Shipped skills, by directory under `skills/`, that arrive with the capability and leave with it. */
	readonly skills?: readonly string[];
	/** Programs it needs on the tool machine, by name. The skill tells the model to run these, so this is the contract
	 *  between the manual and the image. */
	readonly binaries?: readonly string[];
	/** The container it runs, when it runs one. `undefined` for a capability that is a tool or a binary. */
	readonly service?: CapabilityService;
	/** Three numbers, because those are the three things the operator is choosing between. */
	readonly cost: CapabilityCost;
}

/** A service mason runs itself, in a compose file of its own. */
export interface CapabilityService {
	/** The compose service name: what `deploy.sh` checks is running when the capability is on and absent when it is not. */
	readonly service: string;
	/** The file in `deploy/` that defines it. One file per capability, because a profile is dropped by the compose
	 *  provider on this host (`deploy/compose.telegram.yaml:9-11`) and a commented template does not survive a checkout. */
	readonly file: string;
}

export interface CapabilityCost {
	/** What it adds to every turn of every bot that has it, in tokens: the section it owns, or a skill's one line in the
	 *  index. A test pins this to the text it describes, so the number a person reads is the number the prefix pays. */
	readonly promptTokens: number;
	/** Containers it adds to the stack. Empty for a capability that is code or a binary. */
	readonly containers?: readonly string[];
	/** Bytes fetched or carried outside an image: weights, a model, a cache. What a person checks before `up`. */
	readonly downloadBytes?: number;
	/** Money or time per use, in one line, when a use costs something and "free" would be a claim. */
	readonly perUse?: string;
}
```

The first catalog, in id order — this is the whole of it, and the three shapes a capability can have:

```ts
export const CAPABILITIES: readonly Capability[] = [
	{
		id: "generative-ui",
		core: true,
		description: "Answers as a live widget: a chart, a dashboard, a calculator.",
		extensions: ["sandboxed-ui"],
		sections: ["generative_ui"],
		skills: ["generative-ui"],
		cost: { promptTokens: 77 },
	},
	{
		id: "asr",
		core: false,
		description: "Transcribes a voice note before the bot answers it.",
		skills: ["voice-notes"],
		service: { service: "mason-asr", file: "compose.asr.yaml" },
		// 1.3 GB of ONNX graphs, fetched once into the stack's own volume; the decoder is ffmpeg, already in the image.
		cost: { promptTokens: 38, containers: ["mason-asr"], downloadBytes: 1_300_000_000 },
	},
	{
		id: "ocr",
		core: false,
		description: "Reads a photographed page, a scan or a PDF as markdown.",
		skills: ["ocr"],
		binaries: ["indra-ocr"],
		// ~76 MB of weights, fetched at image build time, and 50 tokens of index line: the manual itself is read on demand.
		cost: { promptTokens: 62, downloadBytes: 76_000_000 },
	},
];
```

`generative-ui` is core and `ocr` is optional, and that is a judgement the catalog is the place to argue with rather than
a commit message: a capability that costs one line of index and a layer every image already carries may well deserve
`core: true`, and the entry says so in one word. What it may not be is unlisted — a skill that tells the model to run
`indra-ocr` is a promise, and the entry is where the promise is written down beside the thing that keeps it.

Skill and id happen to be the same word for `ocr` and need not be for the next one: the entry names the directory, so a
capability called `asr` ships a manual called `voice-notes` without the library growing a naming convention.

There is no `needs` field, and that is deliberate: an entry's needs are already visible in what it declares. The volume,
the networks and the memory are in the compose file it names; the model is `cost.downloadBytes` and the volume it fills;
the environment another container needs to reach it is that container's own (`deploy/compose.telegram.yaml:48-52`). A
capability that needed mason's own environment would be a capability configured by an exported variable, which is what
mason already refuses — configuration belongs in a file, and the tool daemon is started with an allowlist precisely so a
tool cannot read the server's environment (`AGENTS.md`, rule 8).

`websearch`, when it is added, is one more entry and its code: no reader changes, no `deploy.sh` change, no bot file
change beyond the bot that names it.

```ts
	{
		id: "websearch",
		core: false,
		description: "Looks things up: search, then read the page.",
		extensions: ["websearch"],
		sections: ["websearch"],
		skills: ["looking-things-up"],
		cost: { promptTokens: 74, perUse: "one provider query per search; a fetched page is tokens, not money" },
	},
```

### 2. The choice is `capabilities.json`, authored in the bot directory

Beside `soul.md` and `skills/`, in the directory `MASON_BOT_DIR` names (`deploy/compose.yaml`, `MASON_BOT_SRC`), and
installed at boot into `service/capabilities.json` exactly as `integrations.json` and `soul.md` are
(`deploy/mason-entrypoint.sh:139-216`): `0600`, on difference, and left alone when the mount is absent.

```json
{ "capabilities": ["asr", "ocr"] }
```

- **`service/`, not `agent/`.** It is a decision a person made, so a tool that could rewrite it could grant itself a
  capability — the reason `integrations.json` is service-owned (`src/server/integrations.ts:9-11`,
  `docs/adr/0002-split-home.md`).
- **Missing, or `{}`: core only.** Nothing optional is on, which is the requirement stated as a default. This mirrors the
  one honest empty set `integrations.json` already has.
- **A list of ids and nothing else.** No per-bot parameters: a capability that needs one is a service with its own
  environment (`docs/adr/0003-integrations-are-services.md`) or it is an integration. That is what keeps an entry enough
  to add a capability.
- **An id the catalog does not have refuses the boot**, naming the id and the whole optional set — the shape
  `readCommands` already uses for the closed command vocabulary (`src/server/integrations.ts:265-285`,
  `src/server/events.ts:59`). A typo that is skipped is a bot missing what its operator asked for, discovered weeks later
  in a message that should have worked; the menu is a dozen lines, so printing it costs nothing.
- **Naming a `core` id is accepted and changes nothing**, because it states a fact. A duplicate id refuses, because it
  means someone believes there are two.
- **Read once, at boot**, like every other file that decides what the model can do
  (`src/server/integrations.ts:1-24`). Changing it is a restart, and the command says so.

Read in `openAgentRuntime` between `configureHouse` and `ensureHouse` (`src/server/runtime.ts:210-216`), because the skill
seed runs inside `ensureHouse` and must already know which skills this bot has.

The module is three functions and one pure resolver: `readCapabilities(path)` parses and validates, `resolve(catalog,
ids)` is a function of two lists and returns the set plus what it contributes — extensions, sections, skills, binaries,
compose files — and is what every consumer and every test calls, `setCapabilities` / `currentCapabilities` are the boot
snapshot the prompt reads. That is why a test can prove what turning a capability on or off does without a capability
existing yet.

### 3. Two readers, one resolver

| Reader | Needs | How |
|---|---|---|
| the server (in the container) | which extensions to select, which sections to render, which skills to seed, which binaries the manual may name | `readCapabilities` → `setCapabilities` → `currentCapabilities()`, a boot snapshot, exactly like `integrations.ts` |
| the stack (on the host) | which compose files make up this bot | `npm run capability -- compose --bot <dir>`, the *same module*, printing one file name per line |

`deploy.sh` already greps `deploy/.env` for the keys it needs and already builds a `-f` list that way
(`deploy/deploy.sh:27-48`); it gains one call, and no parser:

```sh
bot_dir="$(remote "grep -E '^MASON_BOT_DIR=' deploy/.env 2>/dev/null | cut -d= -f2-" || true)"
case "$bot_dir" in ""|/*) path="${bot_dir:-deploy/soul}" ;; *) path="deploy/$bot_dir" ;; esac
capability_args=""
for file in $(remote "node --conditions=source --experimental-strip-types scripts/capability.ts compose --bot '$path'"); do
  capability_args="$capability_args -f $file"
done
stack="$compose -f compose.yaml -f compose.podman.yaml$extra_args$capability_args"
```

The bot directory is read, never the container's home: it is the operator's input, and the script refuses a bad file with
the same message the boot would print, one step earlier (`set -euo pipefail` plus `remote` turns its exit code into a
failed deploy). Nothing in bash ever knows a capability's name.

### 4. A missing thing is refused by the party that can see it

There are three, and none of them degrades silently:

- **The boot refuses what the operator's file gets wrong**, and what only a boot can see: an unknown id, a file that is
  not JSON, an id whose extension this build does not install — the last one being a build that cannot honour an entry,
  refused for the same reason as `assertTriggersHaveHooks` (`src/server/runtime.ts:447-461`): config that names something
  this build does not have is a door that would accept a delivery and drop it.
- **The build's tests refuse what the catalog gets wrong**: an entry naming a skill directory that is not in `skills/`, an
  extension name no boot installs, a section with two owners, a `service.file` that does not declare its service, a
  binary no Dockerfile in the repository installs, a `promptTokens` that does not match the text it describes. These are
  mistakes in a commit, and a test fails in review rather than a stack failing on a host.
- **The deploy refuses what only the stack can see.** `deploy.sh` already proves each container is the image this build
  made (`deploy/deploy.sh:118-139`); it now also proves both directions of the selection against `podman ps`: every
  enabled capability's service is running, and no disabled capability's service is. That is where "a bot that did not
  enable a capability should not run its container" becomes a checked fact instead of an intention — and it catches the
  class of failure this repo already hates, a container with no compose entry behind it.

So a capability enabled with its container missing cannot be caught at boot, because mason has no socket and no business
having one. It is caught by the deploy, which is the only party holding both facts. A server that finds itself in that
state through some other route reports it in one line and in `GET /api/capabilities`, behind the token gate like every
other route (`src/server/main.ts:675-679`), and the capability degrades the way its own face degrades: a skill that tells
the model to transcribe is answered by the relay with one sentence about a transcription that did not happen, which is
what a chat does about anything it cannot do. Nothing is silently half-on: the prompt is unchanged, and it is still
honest about which tools exist.

### 5. A skill belongs to the capability that names it, and is withdrawn with it

`seedShippedSkills` already keeps a record of what it copied and the hash of each copy, so it can tell "ours, nobody
touched it" from "the bot's now" (`src/server/house.ts:231-274`). It gains two rules and no new mechanism:

- **Seed the shipped skills whose owning capability is on.** `skills/` stays flat; the entry names the directories it
  owns, so the library does not depend on a directory convention and a capability may ship two manuals.
- **Withdraw a seeded skill whose capability is off** — delete it, and its record entry, only when the copy still matches
  the recorded hash. A copy the bot edited is left where it is, with one `[capability]` line saying so, because an edited
  file is the bot's and replacing or deleting it would be the one thing seeding must never do.

The withdrawal is what stops a stale copy promising a tool that is absent, and it is a *directory* removed from the
index the prompt is rendered from, not a tombstone: the section that names it is gone with the capability, so the
model is never told to read a manual for a tool it does not have.

A skill is owned by a capability **only if the thing it tells the model to reach can be off**. Know-how that names no
tool is seeded unconditionally: turning it into a capability would give an operator a switch that hides a paragraph.

### 6. Growth is one entry and its code

The rules that keep `websearch` from being a refactor:

1. **The catalog is closed.** A capability is an entry in `CAPABILITIES`; there is no directory to drop a file into and no
   import by convention. Adding one touches `capabilities.ts`, the code it names, and a test — never `deploy.sh`,
   `main.ts`, the entrypoint, or a reader.
2. **Ids are the contract.** `<id>` is lowercase letters, digits and dashes; it is never reused for something else;
   renaming one is a migration, because a bot's file names it and the boot refuses what it cannot find.
3. **No capability assumes another.** If two need each other they are one capability with one entry — the same rule as
   `docs/CAPABILITY-PLAN.md`'s "a capability that could be built in two layers will be built twice, differently". A
   capability may not edit another's section, skill or compose file, and turning one on may not change what another
   renders.
4. **A capability is additive and removable.** Off must restore the prompt byte-for-byte and leave no container, skill or
   selected tool behind. A capability that cannot be off is `core` or it is not a capability.
5. **One service per capability, one compose file per service.** A service that both need is a capability they both are.
6. **Its cost is stated in its own entry**, in the three currencies the operator is choosing between, with the number
   pinned to what it describes.
7. **It costs nothing when off**: no boot work, no dial, no install, nothing in the prefix, no container.

### 7. What this does not change

`BASE_EXTENSIONS` stays the floor and a `core` entry is checked against it, not a second copy of it. `integrations.json`
stays what it is — somebody else's service with somebody else's credential (`docs/adr/0003-integrations-are-services.md`)
— and a capability is mason's own code, binary or container. `mason-telegram` and its `vpn` sidecar stay in their own
files: an interface and its route out are not capabilities (`docs/adr/0004-mason-is-a-headless-backend.md`). `soul.md` and
the bot's own `skills/` keep their precedence: an operator's file wins over a seeded copy.

## Alternatives considered

- **A per-bot install script** (`install.sh` in the bot directory, or a `[capabilities]` block in a shell file). Rejected:
  it is a second implementation of what a capability is, per bot, with no validation and no way to see the library without
  running somebody's script — and a bot's directory is a place a person writes a soul, not a program the deployment
  executes.
- **A plugin directory with dynamic imports** (`src/capabilities/*/index.ts`, imported at boot). Rejected: a directory
  glob is not a list — you cannot read the menu without running the code, and a stray file becomes a capability with no
  entry and no review. Every capability here is first-party and compile-time, so a loader buys nothing and owns the
  error handling for code that was never checked. An integration is already the dynamic path, and it is a *service*,
  not a module: the whole point of ADR-0003 is that the dynamic part has a network face and no privileges.
- **Everything on by default, as `docs/CAPABILITY-PLAN.md` has it** ("a capability nobody has to configure is a
  capability no bot can silently lack"). Rejected as the default, kept as the motive: this ADR answers it with one line
  in a file beside the bot's soul instead of a per-bot install, so a second bot is never born blind and never pays for a
  transcriber it does not use. The bill is concrete — `mason-asr` is a container and 1.3 GB for every stack, and OCR's
  manual plus the widget manual plus a search line are resident tokens on every turn of every bot
  (`docs/CAPABILITY-PLAN.md`, "cost is stated before a capability is added").
- **`integrations.json` as the only mechanism.** Rejected: it describes a service with an endpoint, a hook and a secret,
  written through a CLI (`scripts/integration.ts`), and it has nowhere to put a binary, a skill, a compose file or an
  extension. A capability with no service face would have to pretend to be one, which is how a config file grows a second
  meaning.
- **Compose `profiles`.** Rejected by measurement, not taste: the compose provider on this host drops a profiled service
  from the model even with `--profile` passed and `COMPOSE_PROFILES` set (`deploy/compose.telegram.yaml:9-11`,
  `deploy/README.md:283-284`) — the service is simply missing, with the quieter symptom. The working equivalent is
  already here: one file per capability, and an explicit `-f` list computed from the same file the server reads.
- **A generated `compose.resolved.yaml` committed or written at deploy time.** Rejected: a generated file is a second
  truth that goes stale silently, and this repository's habit is to prove that what runs is what was built rather than
  to trust a file that says so.
- **`MASON_CAPABILITIES=asr,ocr` in `deploy/.env`.** Rejected: the environment is not configuration — the second reader
  of a list is a second truth, and it is invisible to `/api/status`, unreadable beside the bot's soul, and unvalidated
  until a container is already running.
- **Per-bot parameters in `capabilities.json`** (`{"asr": {"url": …}}`). Rejected for now on purpose: parameters are how a
  selector becomes a config format and then a program. A capability that needs one gets a service of its own, or is an
  integration.

## Consequences

- **The library is visible in one file, and the choice in one line.** A person asking "what can a bot do, and what does
  it cost" reads `src/server/capabilities.ts`; a person asking "what does this bot do" reads one list beside its soul.
- **Disabling is as cheap as enabling, and is proven twice.** A stale extension name can survive in a stored selection —
  the repair only appends (`src/server/runtime.ts:415-426`) — but an extension the boot does not install is dropped by
  the selection itself (`vendor/pi/packages/durable/src/harness/agent.ts:315-336`), so the tool is gone without pruning
  anybody's stored document. A withdrawn skill is deleted only when nobody edited it.
- **`mason-asr` moves out of `compose.yaml` and behind a switch**, so the default flips from every stack to no stack.
  The migration below writes down what is on before that flip lands, and a bot that wants it writes `"asr"`.
- **The deployed stack and the running server can disagree, and the deploy now says so** rather than a route. That is a
  new failure mode at the deploy step, and it is the right place: it is the only step that sees both.
- **One prompt section may now be absent, and its absence is a chat-shaped patch** (`renderSections` omits an `undefined`
  section, `vendor/pi/packages/durable/src/harness/prompt.ts:25-48`). It is absent for every turn of a boot, not between
  two turns, so the prefix stays byte-identical where it matters.
- **A stack built by hand is a stack the deploy did not verify.** `podman compose … up` skips the two-direction check;
  the capabilities list is then true about the bot and unproven about the stack.
- **An interface that depends on a capability still reads its URL from its own environment.** `TELEGRAM_ASR_URL` defaults
  to the stack's own service and an empty string means no transcriber (`deploy/compose.telegram.yaml:48-52`); turning
  `asr` off is a stack-level act, and the capability file does not reach across into another container's environment,
  because a capability naming an interface is the wrong direction (`docs/adr/0004-mason-is-a-headless-backend.md`). The
  comment above that default says transcription is on because *every* stack defines `mason-asr`; after step 5 of the
  migration that sentence is the capability file's to make, and the comment is corrected with it.
- **`compose.podman.yaml` may not name a service that only a capability file defines.** It merges into every stack, and a
  `userns_mode` for a service no other file declares is a service with no image. A capability that needs the podman
  override carries it in its own file.

## Migration

Nothing here touches `src/server/extensions/delivery.ts`, `src/server/hooks.ts`, `src/server/projection.ts`,
`src/shared/contract.ts` or the Telegram connector (then `integrations/telegram/`, now
`github.com/DenisSud/mason-telegram`, #104) — the delivery fix in flight. The one shared seam is
`src/server/runtime.ts`, edited in a four-line place.

1. **The library and the reader, selecting nothing.** `src/server/capabilities.ts` with the type and the `generative-ui`
   entry; `readCapabilities` / `setCapabilities` / `currentCapabilities`; the refusals; `scripts/capability.ts` with
   `list` and `compose`; one `[capability]` boot line. Behaviour is unchanged for a home with no file, and a bad file is
   refused. Tests: unknown id, `{}`, missing, duplicate, non-JSON.
2. **The bots write down what they already have.** `capabilities.json` naming `asr` for every stack that runs the relay,
   and `ocr` where the tool machine's image has it. This step is the whole safety of step 4: the default is about to
   become off, and the only honest way to flip a default is to have written down what is on first.
3. **The selection starts to mean something.** `prompt.ts` gains the section-owner map and the `capabilityOn` gate;
   `runtime.ts` builds `extensionList` and `unconditionalExtensionNames` from the enabled set, so a disabled extension is
   neither installed nor selected. Tests: an off section renders nothing, an enabled extension lands in a home that
   booted before it, an off one disappears from one that booted with it.
4. **Skills arrive and leave.** `seedShippedSkills` takes the set and withdraws an unedited copy; `skills/voice-notes/`
   is written for the ASR manual, and `skills/ocr/` becomes a skill this capability owns instead of one every bot gets
   (`ce0b55b` shipped it unconditionally, promising `indra-ocr` to bots whose tool machine may not have the image); the
   entrypoint installs `capabilities.json` from `/run/bot` like `soul.md`. Tests: enable seeds, disable withdraws, an
   edited copy survives both.
5. **The stack shrinks to the selection.** `mason-asr` and `asr-models` move from `compose.yaml` to `compose.asr.yaml`;
   `scripts/capability.ts compose` starts answering; `deploy.sh` appends the `-f` list and checks both directions against
   `podman ps`; `deploy/README.md`'s two-bot recipe and `.env` listing gain the file, and `docs/SPEC.md` gains the
   catalog's row. Tests: every `service.file` exists and declares its `service`; every `binaries` line appears in a
   Dockerfile in the repository.
6. **The first new capability, to prove the rule**: `websearch` as one entry, one extension, one section, one skill, one
   test, and `"websearch"` in the file of one bot.

Steps 1-3 are independent of each other's details and of the delivery work; 4 is what changes the prompt; 5 is the only
step that changes what runs, and it is the one step that must follow 2.
