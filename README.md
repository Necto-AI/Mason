# mason

One process, one bot, one person. mason runs continuously on a machine with Node 22, answers through a connector
(the person's words come in over it, the agent's replies go out through it), and keeps everything it is in one home:
`$MASON_HOME`, else `~/.mason`. The full story of how it is assembled lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Install, and the first run

```sh
npm install -g mason-agent
mason onboard
```

`mason onboard` creates or verifies the home, writes the default soul if none exists, seeds the shipped skills, and
prints the next steps: a connector the bot answers through does not exist yet, so you add one with
`mason integration add <name> --url <mcp-url> --description "…"`, write the entry's `connector` block by hand
(what the connector may do on its socket is its grant, the operator's decision), and then
`mason connector add <name>` issues the credential. `mason onboard` mints that credential itself once the entry has a
grant.

Then `mason up` serves the bot. Changing the integration list is a restart: it is read once, at boot.

## What a stranger reaches

`/api/health` is the only path that answers without a credential, and it answers one word. `/api/connector` is the
connector's JSON-RPC socket and its attachment endpoint; each is the `Authorization: Bearer masonc_…` credential the
`mason connector add` printed once. There is no owner token and no panel: a person speaks through a connector, and a
UI talks to mason the same way.

## The commands the installed package answers

`mason up`, `mason onboard`, `mason integration …`, `mason connector …`, `mason prompt`, `mason surface`,
`mason eval`. They are the npm scripts of a checkout, mapped thin; the checkout's developer docs are in `docs/` and
work from a source checkout with `npm run dev`, whose tests run with `npm test`.

## How a release goes out

```sh
git tag v0.2.0 && git push origin v0.2.0
```

A `v*` tag starts the `release` workflow: the same checks CI runs, then the three packages published with npm
provenance, protocol first, and the three tarballs attached to the GitHub release. Publishing holds no secret: it
is npm trusted publishing, configured once per package on npmjs.com (package settings, Trusted Publisher, naming
this repository and the workflow file).

## The workspace packages inside the tarball

The server imports `mason-protocol` (the connector wire contract) bare. The packages are not on the registry yet
(#124), so `npm run build` copies exactly the packages the emitted imports name — today that is `mason-protocol`,
nothing else — into `dist/node_modules` under that bare name, and that is the copy an installed bot resolves. It
shadows any `mason-protocol` the consuming project happens to have installed: this runtime speaks its own pinned
copy of the wire protocol, deliberately. When #124 publishes, the same commit moves it to an ordinary dependency
and drops the vendoring.
