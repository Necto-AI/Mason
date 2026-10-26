# Containerization and deployment

## What it is

OpenBot ships three deployment shapes from one repository: an all-in-one image that runs the API, the
built web client and a Chromium "computer" under s6 on one port; a `docker-compose.yml` that splits those
into containers plus a Docker-socket supervisor giving each Bot its own computer; and a Helm chart running
the same image as an API Deployment against one shared browser or a `Sandbox` CRD per Bot. The image
excludes PostgreSQL and the supervisor (`Dockerfile:7-15`), so "one container" is true only when the
database is elsewhere or `EMBEDDED_POSTGRES=on`.

## How it works

### The image: six s6 services, three switches

```
/init (s6, root)
 ├ computer-token  oneshot  generate COMPUTER_TOKEN if unset        -> computer-token.sh:11-14
 ├ postgres-init   oneshot  initdb + write DATABASE_URL into s6 env  -> postgres-init.sh:65-74
 ├ postgres        longrun  only if EMBEDDED_POSTGRES=on             -> postgres/run:7-9
 ├ migrate         oneshot  only if EMBEDDED_POSTGRES=on             -> migrate.sh:9
 └ api             longrun  after computer, migrate, postgres        -> api/dependencies.d/*
   computer        longrun  only if EMBEDDED_COMPUTER!=off            -> computer/run:16-18
```

Each service drops to its own account — `apiuser` for API and migrations, `pwuser` for browser and shell,
`postgres` for the database — with s6 staying root because it is the only process that can switch
(`Dockerfile:228-243`, `api/run:6`, `computer/run:53-54`). One port out: 3001; 4100 is deliberately
unpublished (`Dockerfile:252-255`). The `EMBEDDED_*` switches let one image be an all-in-one, a stateless
API replica, or a computer-only pod, since a service that exits 0 is "off". uids 1001/1002 are pinned
because the chart hardcodes 1001 and would otherwise break silently if the base image added a user
(`Dockerfile:39-45`). s6 over supervisord for a stated reason: s6 brings the container down when a
supervised process exits, so the platform restarts it, where supervisord keeps a healthy-looking container
around a dead API (`Dockerfile:97-99`).

### Compose: two networks, everything on loopback

```
 postgres ──[data]── migrate           (migrate is the only service reaching it by name)
 agent-computer :4100 loopback         one browser for every Bot, unless supervisor runs
 agent-bot :4200, agent-langgraph :4201, agent-harness :4202   loopback
 supervisor :4500 loopback + docker.sock(ro)   one computer per Bot
 spire-init/server/agent               optional workload identity
```

Every published port is bound on `127.0.0.1` and `[::1]` (`docker-compose.yml:34-35`, `86-90`, `239-240`).
The `[::1]` half is not symmetry: `localhost` resolves there first on some machines and neither Bun nor
Node falls back, so a single-address publish is intermittently broken (`docker-compose.yml:27-33`). The
network split is the security argument — `postgres` is on `data`
alone, because with no `networks:` key Compose puts everything together and a Bot's shell could open
`postgres:5432` with the passwords three lines above it in the file (`docker-compose.yml:4-15`).
Confinement for supervisor-created computers lives in `hostConfig`: named volumes only, no published port
when a network is set, `no-new-privileges`, `CapDrop: ALL`, `PidsLimit: 512`, `ShmSize: 1Gi`
(`supervisor/src/docker.ts:422-457`). SPIRE is optional and reports absence rather than failing
(`spire/agent.conf:12-14`, `docker-compose.yml:131-138`).

### Kubernetes: one image, three computer modes

`computers.mode` is the topology switch (`values.yaml:327-339`): `shared` renders a headless Service and a
StatefulSet with `replicas: 1` and RWO profile/workspace claims; `sandbox` renders a pod-template
ConfigMap, namespaced RBAC, a culler CronJob and optional SandboxTemplate/WarmPool, and needs the
`agents.x-k8s.io` controller; `external` renders neither. In all three the API is a Deployment with
`replicaCount: 2` and `embeddedComputer: false`, because a browser must not scale with the API tier
(`values.yaml:27-34`).

The API pod runs the **all-in-one** image with its default `/init`, so s6 runs as root and every other
service exits on its switch; that is why the chart's top-level `runAsNonRoot` is false
(`values.yaml:725-728`), while Compose uses the lean `server/Dockerfile` running as uid 1001
(`server/Dockerfile:46-47,67`). Two different server images across two deployments is a real asymmetry,
not a doc slip.

The sandbox provider talks REST to
`/apis/agents.x-k8s.io/v1beta1/namespaces/<ns>/sandboxes`, creates a `Sandbox` with `operatingMode:
Running` and the mounted template, and waits up to 120 s for `status.serviceFQDN`
(`server/src/computer/sandbox.ts:256,305-336`). The template is a mounted ConfigMap rather than an API
read, so the server needs no permission to read ConfigMaps (`computer/pod-template.yaml:10-13`).

The warm pool is manifests and RBAC with no claimant: the chart refuses to render it because `locate`
always posts a new Sandbox and nothing creates a `SandboxClaim` (`values.yaml:465-470`,
`validation.yaml:130-137`). Culling is a CronJob, not a server timer, because an in-process interval fires
in every replica and each would suspend the same browser; work is claimed and leased out of PostgreSQL,
and idleness is read from the audit trail rather than by dialling the browser, which would wake it
(`computer/culler-cronjob.yaml:6-14`, `server/src/work/culler.ts:10-17`).

RBAC is a namespaced Role for `sandboxes` and their status, plus `sandboxclaims` only with a warm pool;
the ServiceAccount token is mounted only in `sandbox` mode (`computer/sandbox-rbac.yaml:19-29`,
`_helpers.tpl:800-802`). The chart contrasts itself with the Docker supervisor, which is root-equivalent
on the host (`sandbox-rbac.yaml:5-10`).

NetworkPolicy is off by default (`values.yaml:690-691`) for the stated reason: inert on a CNI that ignores
it, an outage on one that enforces it (`networkpolicy.yaml:5-8`; EKS ships `--enable-network-policy=false`,
`README.md:541-545`). When on, a computer reaches the open internet minus `10/8`, `172.16/12`,
`192.168/16`, `169.254/16`, and is reachable only from the server pod on 4100 (`networkpolicy.yaml:154-183`);
the API's egress uses the same exception list, because Intelligence, sign-in and Bots are hostnames a
policy cannot match (`networkpolicy.yaml:73-94`).

### Secrets, migrations, crons, health, scaling

- Secrets: a chart Secret marked `helm.sh/resource-policy: keep` so the vault key outlives
  `helm uninstall` (`secret.yaml:9-20`), or `existingSecret`, or an `ExternalSecret` against any store
  (`externalsecret.yaml:1-23`); per-key `optional:` is computed from whether the chart or a store
  certainly holds the key (`_helpers.tpl:203-224`). s6 generates the computer token and the embedded
  database password rather than making an operator invent secrets for processes it cannot address
  separately (`computer-token.sh:8-14`, `postgres-init.sh:43-48`).
- Migrations: a Helm Job on `pre-install,pre-upgrade` **except** a first install with the bundled
  database, where a pre-install hook deadlocks against the database it precedes, so there it is an
  ordinary Job that waits on `pg_isready` (`migrations/job.yaml:10-28,86-93`). In the image they are an
  s6 oneshot for the embedded database only, because an external one is somebody else's release process
  (`migrate.sh:1-9`).
- Crons: routines (off, needs a secret), computer culler (sandbox only), attachments culler (on by
  default, database only). All use `concurrencyPolicy: Forbid` plus `activeDeadlineSeconds`, because
  `Forbid` turns a wedged sweep into a permanent silent stop (`routines/cronjob.yaml:37-40`,
  `attachments/cronjob.yaml:63-104`). Audit and screenshot retention stays in-process
  (`server/src/index.ts:732-733`).
- Health: `/health` returns `{status:"ok"}` with no database check (`server/src/app.ts:456`), so the
  HEALTHCHECK and all probes prove only that the event loop answers (`Dockerfile:256-258`). The computer
  gets readiness and startup but no liveness, because restarting a slow browser loses every signed-in
  session (`computer/statefulset.yaml:171-190`).
- Scaling: HPA off by default (`values.yaml:44-50`); PDB only when replicas > 1, since `minAvailable: 1`
  over one replica blocks a drain forever (`server/pdb.yaml:6-13`); soft anti-affinity
  (`values.yaml:57-60`). The computer tier never scales horizontally.

### Sandbox posture, honestly

Real boundaries: one container per Bot; gVisor/Kata as an opt-in `RuntimeClass` or `COMPUTER_RUNTIME=runsc`
(`values.yaml:341-344`, `docker.ts:446-449`); `no-new-privileges` and `CapDrop: ALL` under the supervisor;
NetworkPolicy separating computer from database; no service-account token in a computer pod
(`_helpers.tpl:709-712`, `computer/statefulset.yaml:69-77`). Floors the code names as floors: uid 1001 is
not containment against the Bot's own shell, since `pwuser` has passwordless sudo for apt/dpkg and that
escalates by design (`values.yaml:355-391`); `--no-sandbox` Chromium makes the process user the boundary
(`Dockerfile:235-237`); and in Compose the computer image creates no user and runs as uid 0 — the chart
says so (`values.yaml:346-353`). There is no SPIRE in the chart at all: workload identity exists only on
the supervisor path.

## Decisions and their reasons

**One image, switches instead of Dockerfiles.** One artifact, one build; cost is a container that can be
six processes and a chart whose security context is false because s6 must be root.

**Loopback publishing rather than `internal: true`.** The comment argues the token is the control and
loopback keeps the surface off routed networks (`docker-compose.yml:86-90`). Cost: a Bot's computer on the
default network can still reach `agent-bot:4200` or `supervisor:4300` by name — shared tokens, not absence
of a route.

**A supervisor holding the Docker socket.** Real per-Bot isolation on one host, at the price of a
root-equivalent process; it cannot ship in the image because no serverless platform permits a socket
(`Dockerfile:13-15`).

**CronJobs for anything that must not run twice.** Correct across replicas; costs three workloads, their
policies, and the `Forbid`-plus-deadline trap the comments spend paragraphs on.

**Refuse at install, naming the value.** 400 lines of `fail` with the fix in the message, including
refusing `warmPool` while it cannot work and refusing an empty `kubernetesApiCidr` that would widen a
policy to everywhere (`_helpers.tpl:145-165`).

**Where code and docs disagree.** The README claims the defaults are for a plain cluster
(`README.md:204-217`); true, but the culler comment admits the bundled-database label bug survived because
"the cluster it was driven on ships enforcement switched off" (`culler-cronjob.yaml:61-69`), and
`ci/self-hosted-values.yaml:49-54` turns NetworkPolicy on only so it renders.

## Mason-relevant

**Worth copying**

- Membranes as comments that name the failure mode (`docker-compose.yml:4-15`, `networkpolicy.yaml:57-72`).
  mason's compose is already this genre.
- Migrations as a release step with the deadlock reasoning written down (`migrations/job.yaml:10-28`).
- Refuse at boot, naming the fix: `postgres-init.sh:29-41` explains a volume holding `lost+found` instead
  of letting `initdb` fail generically. mason's entrypoint already refuses with a named cause.
- "Generate, do not require" for secrets an operator cannot sensibly invent (`computer-token.sh:8-14`).
  mason mints its own tokens and env keypair; the rule is worth naming.

**Worth avoiding**

- The chart: 732 value lines, 829 helper lines, 400 validation lines, five CI targets, HPA and PDB for two
  replicas, and a warm pool it refuses to use. For five people on one host, four `internal: true` networks
  and one loopback port already buy more.
- s6 with three `EMBEDDED_*` switches — a good answer to "one image, many shapes", unnecessary for a
  two-container stack where the entrypoint `exec`s one process.
- `sudo` for apt inside the tool container (`Dockerfile:176-203`). Honest as a floor, but
  `deploy/env.Dockerfile:52-54` (no sudo, no daemon) is strictly better for an agent that writes commands.
- Egress control as an env var: a shell in the computer can unset `EGRESS_PROXY_<BOT>`
  (`values.yaml:448-452`). `mason-egress: internal: true` with a single reachable address
  (`deploy/compose.yaml:291-299`) is a route that does not exist, and wins.
- Root computer containers in Compose (`agent-computer/Dockerfile` has no `USER`) against 1001 in the
  chart. mason's 1000:1000 on both images (`deploy/compose.yaml:26-30`) is the invariant to keep.

**Already right in mason**

Two containers, one loopback port, no ingress, TLS left to a proxy (`deploy/compose.yaml:16-17,77-80`).
openbot needs a supervisor, SPIRE and a proxy to approach what mason gets from a mount boundary: a missing
`service/` directory is cheaper than a NetworkPolicy (`deploy/README.md:18-30`).

## Open questions

- Whether a static `/health` matters in practice: nothing tests the database, so a pod with a dead pool
  stays Ready.
- Multi-arch: `TARGETARCH` is translated for s6 (`Dockerfile:104-112`) but the README states the published
  image is `linux/amd64` only (`README.md:11-19`). Whether arm64 publishes is unknown.
- Whether `sandbox` mode was ever exercised under an enforcing NetworkPolicy. The comments say the cluster
  used had enforcement off; nothing in the repository settles what was actually run.
