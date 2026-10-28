# Capability plan — what the agent can do, and in what order

The bot that went live for Таня answers text and reads files. That is the floor, not the product. This is the plan for
raising it: which capabilities, where each one lives, what it costs, and the order that keeps every step shippable.

The three questions that decide the design are the same for every capability below:

1. **Does it belong to the server or to one bot?** A capability every bot needs (search) belongs to the server and is
   configured once. A capability with models, memory or a dataset behind it belongs to a service, reached over MCP, and
   a bot opts in through `integrations.json`.
2. **Where does the service run?** On the host, once, shared by every stack — not inside a bot's compose project.
   Otherwise two bots are two copies of one GPU.
3. **What does the model see?** One line per integration in the resident prompt, plus the tool schemas. Every capability
   is paid for on every turn of every bot that has it, so a capability nobody uses is a tax on the ones that matter.

## The rule that decides where a capability lives

**mason's own capabilities ship in code, so every bot has them.** A capability nobody has to configure is a capability
no bot can silently lack. Transcription is a service in `deploy/compose.yaml`, so a second stack gets its own container
and its own model volume from the same file, and the relay's default endpoint is that service by name; OCR is a binary
in the tool-machine image plus a skill in `skills/`, which every agent's home receives on first boot. Search, the
capability phase 1 below is for, is the third shape the rule allows — a first-party tool in `src/server` — and it is
not in the tree yet.

`service/integrations.json` is for **somebody else's service**: an endpoint and a credential that belong to one person,
or a tool the operator registers deliberately. Transcription, OCR and search must not be integrations — a new bot would
be born mute, blind and unable to look anything up, and only a human editing a JSON file could fix it.

The rule above is what is built, and it has the cost `docs/adr/0007-capabilities-are-listed-once-in-code.md` opens
with: every bot pays for every capability, in tokens in its own prefix and in containers on its own stack. That ADR
designs the answer — a catalog in `src/server/capabilities.ts`, a bot's choice in a `capabilities.json` beside its
soul, the same list read by `npm run capability -- compose` for the stack, and `GET /api/capabilities` for a person
asking what a running bot has. None of it is in the tree: there is no `capabilities.ts`, no reader for such a file, and
no such route. Until it lands, this document's rule and the compose files are the whole of the answer.

## The four layers, and what goes in each

| Layer | What it is | Fits |
|---|---|---|
| **pi's own tools** | the tool machine: `bash`, `read`, `write`, `edit`, plus pi's web tools when enabled | anything that is a process on a machine: counting a table, converting a file, reading a page |
| **MCP integration** | a service with an endpoint, declared in `service/integrations.json`: one line of description, tools under `mcp__<name>__*` | models the tool machine cannot hold, or state one bot must not see: a GPU ASR, an index, a mailbox |
| **Skill** | `agent/skills/<name>/SKILL.md`, read on demand | know-how: how a курсовая is built, how a кафедра wants citations, how to phrase a refusal |
| **Hook** | a signed trigger or a schedule that starts a turn | proactivity: a morning brief, a deadline reminder |

A capability that could be built in two layers is a capability that will be built twice, differently. Pick one and say
why in the commit.

## Order of attack

### Phase 1 — search and page reading (highest value, least work)

She asks about literature, checks a fact, wants the current ГОСТ wording. Today the bot has no way to look anything up,
which makes it a very confident assistant with no library.

- Search must be **server-side or a shared service**, not per bot: the same index serves everyone.
- Needs: a backend (self-hosted if one exists on the host, otherwise a key-based API), a fetch/read step so a result is
  not just a snippet, and a cap on what it may fetch (scheme allowlist, no link-local or private ranges — an MCP fetch
  tool that follows arbitrary URLs is an SSRF hole pointed at the host network).
- Definition of done: she asks «найди статьи про социальный капитал за последние 5 лет», the bot returns real, openable
  sources, and says honestly when a source is paywalled.

### Phase 2 — voice in, and a transducer behind it

She sends voice messages. The relay delivers a voice message as a **file in her workspace with a path in the
payload**, like every other attachment, and asks a service for the words before the event is signed so that the payload
carries both.

**Shipped**, with three differences from the shape this phase first proposed. The service is `asr/` in this repository
— one container per stack rather than one on the host, in `deploy/compose.yaml` with its own weights volume — and it is
CPU only, because the image carries no CUDA runtime and no driver to talk to, one `POST /transcribe`. And it is not an
MCP tool: `mason-telegram` makes the HTTP call itself (`integrations/telegram/src/asr.ts`), which is why there is no
`transcribe(path)` tool and no skill teaching the model a procedure. The transcript arrives as a block that says it was
spoken and not typed, and that label is the job the proposed skill had.

- A transcript, a clip transcribed as silence, and a service that did not answer are three states, and only the first is
  words. A failure never drops the message: it goes on with a sentence saying the note could not be transcribed, which
  is the honest half a person can act on.
- The file is posted byte for byte as it landed in the inbox; decoding an Ogg/Opus recording is the service's side of
  the contract, not the relay's.
- `TELEGRAM_ASR_URL` in `deploy/compose.telegram.yaml` defaults to the service by name, so a stack that runs the relay
  gets transcription without a line in `.env`.
- Done when she sends a 40-second voice note about a курсовая and gets an answer to its content.

### Phase 3 — OCR: Indra, in the tool machine

Photographs of конспекты, scans of методичек, screenshots of заданий, PDFs of articles.

**Decided: Indra OCR** (`datalab-to/indra`), the same tool `~/dev/pi-setup` already wraps (`nix/indra-ocr.nix`,
`extensions/ocr/index.ts`): a small ONNX graph (det 0.4 MB, rec 5 MB) on CPU, with the OpenCV/PDFium post-processing that
makes reading order, headings, lists and tables come out as markdown. ~76 MB of weights, fetched when the image is
built rather than on the first message, so a machine with no route out reads a page all the same.

It runs **in the tool machine**, not as an MCP service, and that is the whole argument: the file is already there. A
photo of her конспект is on the inbox volume, the tool machine has it at the same path, and `indra-ocr <path> --format
md` is one process away — no upload, no second copy, no service to reach over a network. An MCP hop would buy nothing
and cost a container.

**Shipped.** `deploy/env.Dockerfile` installs `git+https://github.com/datalab-to/indra@v1.1.2` into a virtualenv at
`/opt/indra`, links `indra-ocr` onto the PATH and warms the cache at build time, then repeats the lookup with
`HF_HUB_OFFLINE=1` so a build that could not fetch fails instead of shipping an OCR that downloads on the first
message. Ubuntu wheels exist for every dependency, so nothing compiles; the Nix packaging exists because NixOS has no
usable `opencv-python-headless`, which is not true here. `test/capability-wiring.test.ts` fails if the pin, the offline
check or the skill disappears.

- Reaching for it is a **skill**, not new code (`skills/ocr/SKILL.md`): «PDF, скан или фото страницы — сначала
  `indra-ocr <path> --format md`, потом работай с текстом; если это рукопись — проверь по картинке слова, в которых
  OCR уверен плохо».
- Handwriting stays the honest limit: an OCR line model misreads cursive, and the answer to that is not a bigger model
  but saying which fragments are uncertain instead of inventing a sentence.
- Done when a photographed page of her handwriting yields text with the doubtful words marked, and a 20-page PDF of an
  article yields markdown in one call.

### Phase 4 — voice out, and the calendar

- **Voice out** (TTS) is a comfort feature: she reads faster than she listens to a bot. Only worth it after voice-in
  proves she uses voice at all.
- **Deadlines and reminders** are the one place where mason already has the machinery: a hook on a schedule, and the
  agent's own memory. A reminder that arrives is worth more than a summary nobody asked for.

### Not planned

Anything that turns the bot into a second product: a browser UI she has to learn, a calendar she has to maintain by
hand, a document editor. The chat is the product.

## Cross-cutting, decided once

- **One place for models, and today it is inside the stack.** OCR needs no model server at all: it is a binary in the
  tool-machine image, next to the files it reads. ASR is a container in `deploy/compose.yaml` with its weights on a
  volume named after the stack, so each bot runs its own copy and restarting one bot's transcriber is not an outage for
  another's. A model too big for that — an embedding index, a GPU that two bots would contend for — is the case where a
  service of its own, in its own compose file and on its own network, becomes the answer.
- **Reachability without host ports.** A service joins the bot's `mcp` network under a stable alias, so no port is
  published and no other tenant of the host can reach it. Where a published port is unavoidable, it binds loopback and
  carries a token of its own.
- **The trust boundary moves, and has to be redrawn.** Every capability added is a new way for text from a stranger to
  reach a process: a fetched page, a transcript, an OCR of a photographed page. Two rules survive all of them: files and
  pages are data, never instructions; and a capability that fetches has an allowlist, because the container it runs in
  can reach the host's private network.
- **Per-bot opt-in is designed, not default.** Everything mason owns is in code, so every stack gets it: ASR, OCR and
  the widget manual are in every bot today, and a bot that only reports issues pays for a transcriber it never calls.
  The choice that would fix that is `docs/adr/0007-capabilities-are-listed-once-in-code.md`, and none of it is built.
  `integrations.json` stays what it is — somebody else's service, per stack — and is not the switch for mason's own.
- **Cost is stated before a capability is added**, in tokens per turn and in money per month, in the commit that adds it.

## What "done" means per capability

A capability is not shipped when the tool answers. It is shipped when: the model reliably reaches for it without being
told (the description is the trigger), a failed call degrades to a sentence a person understands, it costs what the plan
said it would, and one test in the repo fails if it disappears.

The last of those exists, and it is `test/capability-wiring.test.ts`: it reads the files that wire OCR and the
transcriber in and pins the parts a person would have to delete to remove either — the Indra pin and the offline check
in `deploy/env.Dockerfile`, the `ocr` skill's frontmatter and its `indra-ocr <path> --format md`, `mason-asr` on
`mason-mcp` and `mason-out` and never on `mason-edge`, `TELEGRAM_ASR_URL`'s default, and `mason-env` off `mason-edge`.
It pins presence and shape, not behaviour: behaviour is measured where the capability lives, in `asr/`'s own suite and
in `integrations/telegram`'s.
