# Which mechanism should let a mason connector add code to mason?

## The question, in one sentence

Denis finds mason's connector model limiting — today an integration is a config entry plus a separate container that
speaks MCP and posts signed events, and `docs/adr/0003-integrations-are-services.md` forbids per-connector code in
`src/` entirely — and he wants connectors to work **more like pi extensions: a thing that adds to the codebase** (a
module that registers tools, prompt sections, hooks, commands, entry kinds), without turning the server into a plugin
host that loads arbitrary code with its own privileges. This run finds the mechanism: the seam, the contract, the
loading/lifecycle model, the trust model, and the version story, judged against mason's existing invariants.

## What the answer is for

A decision, written up as an ADR plus a spec, that supersedes or amends ADR-0003 (and interacts with the proposed
ADR-0006 and ADR-0007). Denis is the reader and the decider. Nothing is built in this run: the deliverable is the
mechanism, argued and evidenced, with a recommendation he can accept, reject, or redline.

## What a good answer contains

1. **The contribution surface, named.** Exactly what a connector may add to mason, as a closed list: tools, prompt
   sections, hooks/trigger kinds, commands, entry kinds in the projection, ingest work, reply routing, state
   subscriptions. For each: what it mutates, when it takes effect, and what mason must own so a connector cannot
   mutate it.
2. **The seam, placed.** Where the code lives and how it is reached: in-tree module compiled with the server
   (`src/connectors/<name>/`), out-of-tree code loaded at boot (`service/connectors/<name>/`, jiti/dynamic import),
   out-of-process peer behind a protocol, or a hybrid that keeps one manifest and two loaders. Say which one, and why
   the others lose.
3. **The loading and lifecycle model.** When a connector is resolved, what a restart means, what happens mid-turn,
   what happens on a bad connector (refuse the boot, drop it, quarantine), and how the *prompt prefix stays
   byte-identical between two turns of one build* — mason's hardest constraint, because the tool list and prompt
   sections are the prefix.
4. **The trust and privilege model.** In-process code has the server's privileges: what the door is, who may add a
   connector, what a connector can read (`service/` secrets? `agent/`? the network?), and how a first-party connector
   differs from a third-party one. If the answer relies on isolation, name the mechanism and what it actually
   contains.
5. **Versioning and drift.** How a connector declares the host API it was written against, how mason refuses or
   degrades an incompatible one, and what the deprecation story is when the contribution surface changes.
6. **The migration.** What happens to `integrations.json`, the MCP tool face, the HMAC door and `npm run integration`:
   kept, wrapped, or retired, and in what order.
7. **The cost.** Lines of code, containers, tokens per turn, review burden, and the number of things a person must
   learn to add a connector — stated per candidate so Denis can compare.
8. **Evidence, not vibes.** Every claim about how another system works carries a verbatim quote and a primary source.
   mason's own invariants are quoted with `file:line`.

## The candidates to compare (at minimum)

- **A. In-tree code modules** — a connector is a TypeScript module in this repo, compiled in, declaring its
  contributions through a host API; adding one is a commit. (Home Assistant's in-tree integrations are the
  best-documented instance of this shape.)
- **B. Out-of-tree code loaded at boot** — a connector is a package in a directory outside `src/`, imported at boot
  with a manifest and a version gate. (pi's own extensions are this shape; so are Claude Code "mods".)
- **C. Out-of-process peer with a richer protocol** — today's MCP + HMAC, extended to carry what code would otherwise
  give. (The question is what MCP can actually carry, and what it cannot.)
- **D. Hybrid** — one manifest and one contribution model, two loaders (compiled-in for first-party, boot-loaded for
  operator-supplied), with the trust difference stated on the entry.

Any candidate the evidence supports that is not on this list belongs in the report.

## Scope edges

**In bounds.** mason's own code and docs in `/home/denis/dev/mason` (especially `src/server/`, `docs/adr/`,
`docs/SPEC.md`, `docs/CAPABILITY-PLAN.md`, `docs/CONNECTOR-PROTOCOL.md`, issues #16, #60, #61, #62, #69); the pinned
vendor submodule `/home/denis/dev/mason/vendor/pi` (pi's extension API, its loader, `packages/durable`'s
`defineExtension`, `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/docs/packages.md`); public
primary documentation for Home Assistant integrations, Claude Code plugins/mods, VS Code's extension host and API
versioning, MCP 2025-11-25, Node's module/vm/worker/isolated-vm story, and any agent runtime that ships in-process
plugins.

**Out of bounds.** Writing or changing code in mason (this run is read-only); researching vendor APIs (Yandex,
Telegram) — already covered in `docs/research/yandex-integrations/`; multi-user or fleet concerns (ADR-0001, apiary);
the operator console and UI work; anything that needs a paid API key to inspect.

**Authoritative for this topic.** The running code beats the docs; the vendor's source beats its marketing; the spec
beats a blog post about the spec. Where a doc and the code disagree, say so in `## Conflicts`.

**Today's date.** 2026-10-30. Anything time-sensitive (a spec revision, a project's status, a deprecated API) must
carry the date it was checked.

## How the report will be judged

Denis reads the first page and knows which mechanism he is choosing between and what each costs. Then he reads the
recommendation and can see, line by line, which of mason's invariants it satisfies and which it deliberately breaks.
A report that describes six systems well and recommends nothing has failed. A report that recommends without quoting
the invariant it strains has failed too.
