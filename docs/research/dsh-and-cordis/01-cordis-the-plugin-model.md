# Cordis — the plugin model under dsh, and what it actually costs

> Research note, 2026-11-03. Read from the vendored source in `deepseek-ai/deepseek-harness`: `vendor/cordis/src/`
> (`context`, `service`, `registry`, `fiber`, `reflect`, `events`, `utils`), `vendor/{loader,include}/src/`,
> `vendor/README.md`, `docs/cordis-primer.md`, `docs/cordis-tutorial/01`–`07`, `docs/postmortem/0001`,
> `packages/AGENTS.md`. Line numbers are from the vendored copy, which is *not* upstream: the README logs 20 local
> modifications (IDs up to V27; an entry is removed when its divergence goes away and IDs are never reused) and two of
> them change plugin-author semantics. `[judgement]` marks my reasoning.

## 1. What it claims

The paper behind it (`A Programming Paradigm for Spatiotemporal Composability`, arXiv 2608.25512, Shi/Zhang/Cui, Aug
2026) names two dimensions of dynamic composition and proves five theorems about a calculus in which both hold:

- **Temporal**: every effect a component has on the context carries an inverse the runtime keeps, so removing the
  component returns the system to the state it would have had if the component had never acted.
- **Spatial**: every dependency is declared, and the runtime activates a component only when its dependencies are served —
  and deactivates it when they go away.

Cordis is the implementation. dsh does not depend on it from npm; it copies the framework into `vendor/` "so that the
harness fully owns its framework layer (auditable, patchable, pinned)" (`vendor/README.md:3`). That is the same move mason
makes with `vendor/pi`, and the same cost: the fork's behaviour is the behaviour you have.

Two of the 20 logged local patches matter to anyone reading this: **V6** closes "three reentrant disposal gaps" upstream, and
rejects effect creation while the owner is unloading (`vendor/README.md:39`); **V7** enriches JSDoc because the doc
generator hard-errors on undocumented members. So the semantics below are the fork's, not upstream's.

## 2. The primitives, mechanically

| Concept | What it is | Where |
|---|---|---|
| `Context` | A `Proxy` over a prototype-chained object; reads outside the chain go through a service resolver. Child contexts come from `extend`, never from mutating a parent. | `vendor/cordis/src/context.ts:42`, `:99-107` |
| Plugin | Three accepted shapes — a bare function, `{ apply }`, or a `Service` subclass — normalised to one callback | `registry.ts:92-96,222-228` |
| Service | A named capability claimed on `ctx` by `super(ctx, name)`; the claim is an effect of the owning fibre | `service.ts:42-59` |
| Scope | `isolate(name, label)` re-labels a service name for everything below; `intercept(name, config)` injects per-service config for everything below. There is **no `fork`** in this framework. | `context.ts:112-145` |
| Event | One hook table keyed by name, five dispatch modes fixed per event, declared by TypeScript declaration merging | `events.ts:31,334-371` |
| Effect | The only disposal currency: `ctx.effect(body)` runs `body` now, keeps the disposer it returns, and runs it at unload | `fiber.ts:421-567` |

An **effect** is the piece that makes the whole thing work, and it is not a `Context` method — it is a mixin onto
`ctx.fiber.effect` (`reflect.ts:234`), so effects belong to the fibre. The accepted shapes are generous: a disposer, a
promise of one, an iterable, or an **async generator** that yields disposers as it produces them (`fiber.ts:78-93`). That
last form is how a service does asynchronous startup and still disposes correctly.

Running order is the part people get wrong: "disposers start in reverse registration order, but multiple async disposers
run **concurrently**" (`fiber.ts:720-730`; stated twice in the docs). Concurrency here is not an implementation detail —
it is the root of most of the sharp edges in §6.

## 3. Activation is dependency-driven, and that is the whole design

`inject` is the spatial half, and its mechanism is small enough to state exactly:

1. `Inject.resolve` turns the plugin's `inject` into a plain map (`registry.ts:330`).
2. The fibre copies each non-null entry into a child intercept map (`fiber.ts:242-249`).
3. After the plugin is published, each injected name is looked up in the context's isolate slot and checked
   (`fiber.ts:320-325,603-615`).
4. `_refresh()` builds an **epoch string** `"<revision>:<implUid>:<implUid>…"`, or `INACTIVE` if any dependency is
   missing (`fiber.ts:617-628`).
5. `INACTIVE → live` loads; `live → INACTIVE` unloads (`fiber.ts:630-646`).

Four consequences follow, and they are the reason the harness can be composed instead of booted in order:

- **Row order means nothing.** "Entries start concurrently, so list position guarantees nothing about which plugin loads
  first" (`docs/cordis-tutorial/01-first-plugin.md:31`); the base composition says the same: "Row order carries no load
  semantics (activation is service-availability driven)" (`packages/bundle/base/cordis.patch.yml:12-13`).
- **Replacing a provider restarts every dependent**, because the uid is in the epoch (`fiber.ts:625`). That is what makes
  swapping one `shell` implementation move Bash, PTY and LSP with it.
- **Losing a service unloads its consumers** and they reload when it returns (`03-services.md:74-76`). There is no
  separate "optional" mode in the core; optional dependencies are read with `ctx.get(name)` instead.
- **A missing dependency is silent, forever.** "a plugin whose `inject` names a service nobody provides waits forever,
  printing nothing. No error — PENDING is a legitimate state" (`06-composition-and-hmr.md:63`). PENDING *means* "the epoch
  is INACTIVE" (`fiber.ts:580-585`), so a typo and a legitimate wait look identical. The documented diagnostic is to walk
  the registry by hand (`06-composition-and-hmr.md:65-83`).

There is also a hole in the "declared dependencies" story worth knowing: the **Loader overwrites a plugin's `inject` from
the YAML row** (`vendor/loader/src/index.ts:128-134`, and the fibre documents the possibility at `fiber.ts:317-320`). So
the composition, not the module, is the final authority on what a row waits for. `[judgement]` That is a feature for
provider swapping and a hazard for reasoning about a plugin in isolation.

## 4. Events are the interception layer

Five modes, and the mode is part of the event's public contract — "can only be dispatched by these methods accordingly"
(`docs/cordis-primer.md:17`): `emit` (observe), `serial` (in order, has a value), `parallel` (all at once), `bail` (first
non-null wins), `waterfall` (around-middleware).

`waterfall` is the interesting one for a harness: a listener receives `(...args, next)`, calls `next()` to delegate, or
returns without it to own the decision. The repo rule is repeated in four places — "Waterfall listeners must call
`next()`" — with the failure mode named: "Forgetting `next()` in a logging listener silently swallows the default
behaviour for everyone downstream" (`04-events.md:138`).

Events are also how the framework extends itself: `internal/config` and `internal/update` are waterfalls
(`events.ts:347-362`), so a third party can rewrite config resolution or veto a reload. The plugin model is extensible
from inside because lifecycle is itself expressible as events.

## 5. Composition: rows, patches, and four words that are not synonyms

| Term | What it is | Where |
|---|---|---|
| plugin | "a TypeScript module that exports an `apply` function" | `docs/user/develop/basic/index.md:17` |
| bundle | an npm package that ships a configuration layer, declaring `dsh.bundle.patch` — "what does this package contribute?" | `publish.md:13,42` |
| profile | a directory under `$DSH_HOME/profiles/<name>` listing the bundles to stack — "which bundles compose this setup, in what order?" | `publish.md:14` |
| preset | one agent's child plugin list, declared by an ordinary plugin row (`@deepseek-ai/dsh-agent-preset`) | `packages/preset/agent-preset/README.md:12` |

The stated rule is blunt: "A bundle is what you author and distribute; a profile is what a user boots… Nothing is both."
Layers apply in order — bundle patches, then the profile's own `cordis.patch.yml`, then the home patch, then `--patch`
overlays — and a patch **replaces a row's whole `config`** rather than deep-merging (`publish.md:131`).

Two properties of the patch language matter at scale, both confirmed in the source:

- **Every failure is a warning, not an error.** `patch: entry %C not found`, `name mismatch … skipping`, `id is required`
  (`vendor/include/src/patch.ts:70-105`). A patch that matches nothing does nothing and says so once, in a log line.
- **The journal routes a runtime edit back to whoever owns the key** — the file, the last patch that overrode it, or the
  patch that inserted the row (`patch.ts:111-116,191-260`). This is what makes the Web plugin manager's edits land in the
  right file.

The payoff is visible in the superagent: a whole application attaches as three inserted rows plus two presets
(`03-the-superagent-as-a-bundle.md` §6).

## 6. What the discipline is, and what it costs

The repo enforces plugin-author rules that are *not* expressible in types, and it is honest that they are not:

- "Prefer events for interception and policy; prefer service methods for direct capability calls" (`cordis-primer.md:43`).
- A provider and a consumer **do not depend on each other**; both depend on the Service Definition (`practice/index.md:50-54`).
- "Give shared state an owner… A module-level cache, a singleton, a global `WeakMap` … hides that owner"
  (`packages/AGENTS.md:13`).
- "Enforce a decision in the operation that makes it… Schema omission, prompt filtering, facades, wrappers, and listener
  order are not enforcement" (`packages/AGENTS.md:17`).
- Export shape is a rule: a service package default-exports its class; a function plugin named-exports `name`/`inject`/
  `Config`/`apply` and must not also have a default. Why is a postmortem: `Loader.unwrapExports` does
  `exports = exports.default ?? exports`, so one stray default export **discarded `name`, `inject` and `Config`**, and the
  plugin then ran with an empty inject map (`docs/postmortem/0001-acp-default-export-drops-inject.md:39-54`).
- Optional dependencies must use `ctx.get(name)`: the property proxy walks **ancestors only**, from the *definition site's*
  fibre, so a sibling-provided service is unreachable and the read throws (`postmortem/0001:77-87`).
- That postmortem ends on the sharpest line in the tree: the bug was invisible to hand-mounted tests because a test-only
  branch in `reflect.ts` bypassed the real path — "100% line coverage was satisfied the whole time. Coverage proves lines
  *ran*; it says nothing about whether the feature works *the way it ships*" (`:98`). Hence the standing rule that
  product-visible plugins need a REAL-composition test through the loader, not a hand-built `ctx.plugin(...)` suite
  (`packages/AGENTS.md:7`).

And the costs, all stated by the repo itself:

| Cost | Statement |
|---|---|
| Concurrent disposal creates a real race | "The current fiber unload starts sibling disposers concurrently… **Adding `inject`, reversing registration order, or retaining a service reference does not fix that race.**" (`skills/cordis-styling-nitpicking/SKILL.md:41`) |
| Cleanup cannot register cleanup | effect creation is refused while the fibre is `UNLOADING` (`fiber.ts:426-428`, a V6 patch) |
| Isolation covers services only | one event bus per process; two isolated groups still see each other's events unless a filter is set `[judgement]` from `context.ts:112-145` + `events.ts:168-170` |
| Service names are one flat namespace | the harness claims plain `tools`, `llm`, `agents`; authors are told to prefix (`03-services.md:92-94`) |
| The dispatch mode is not checked against the dispatch site | the primer claims the generated catalogue checks it; the generator only checks the declared signature shape (`typert/generator/src/cordis-catalog.ts:200-211`) — an event declared `emit` and dispatched as a waterfall typechecks |
| Type safety is declaration merging only | it "generates no code; without it the service still works at runtime, but consumers lose type safety" (`03-services.md:40`); and the merge is only visible to a file that imports *something* from the declaring module, hence the `import type {} from …` idiom |
| Nothing checks that a merged `ctx.x` is ever provided | no gate found; the catalogue gate is about docs, not runtime identity `[judgement]` |
| A disposed fibre can never restart | `uid = null`; `assertActive()` throws (`fiber.ts:142-146,357-360`) |
| Config cannot be validated asynchronously | `throw new TypeError('Async config validation is not supported')`, with a `TODO` (`fiber.ts:50-62`) |

The most useful sentence in the whole framework, for anyone deciding whether to adopt it: the ordering race is fixed by
**an idiom, not a feature** — "a function plugin with one `ctx.effect(function* () { … })` that yields the exact disposers
of its registrations and publishes the service last" (`cordis-styling-nitpicking/SKILL.md:45-55`). A model this careful
about composition still leaves the interesting cases to a hand-written generator.

## 7. What survives without the framework

None of the rules in §6 need Cordis. They need:

1. a **name** for every capability, claimed once, with a duplicate claim being an error rather than a shadow;
2. a **declared** dependency, checked at start, where "missing" fails loudly instead of waiting forever;
3. an **owner** for shared state, so a module-level `let` is a review finding rather than a convenience;
4. **registration that returns its own undo**, so a removal is a removal;
5. **loud misconfiguration**, always, because every silent default in this framework is a debugging session later.

mason already has (3) as a value and violates it twice, by design and with a comment; it has (1) partly, through a
registry of extensions selected by name; and it has none of (2), (4) or (5) in a form a contributor can rely on. Those are
the four things worth taking, and they are all rules, not runtime. `[judgement]`
