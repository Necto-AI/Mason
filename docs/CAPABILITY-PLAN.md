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
in the tool-machine image plus a skill in `skills/`, which every agent's home receives on first boot; search is a
first-party tool in `src/server`, on by default.

`service/integrations.json` is for **somebody else's service**: an endpoint and a credential that belong to one person,
or a tool the operator registers deliberately. Transcription, OCR and search must not be integrations — a new bot would
be born mute, blind and unable to look anything up, and only a human editing a JSON file could fix it.

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

She sends voice messages. The relay must deliver a voice message as a **file in her workspace with a path in the
payload**; today that is the open question. Then a Parakeet ASR service turns it into text.

- The relay change is small and belongs in `integrations/telegram`: a voice note is an audio file, named in the payload
  like any other attachment, so `read` and an ASR tool both work on the same path.
- The ASR service is one container on the host, GPU if there is one, one MCP tool: `transcribe(path)`.
- The bot's instruction is a skill, not code: «голосовое → сначала расшифруй, потом отвечай», and it must never quote a
  transcript as if she had written it.
- Done when she sends a 40-second voice note about a курсовая and gets an answer to its content.

### Phase 3 — OCR: Indra, in the tool machine

Photographs of конспекты, scans of методичек, screenshots of заданий, PDFs of articles.

**Decided: Indra OCR** (`datalab-to/indra`), the same tool `~/dev/pi-setup` already wraps (`nix/indra-ocr.nix`,
`extensions/ocr/index.ts`): a small ONNX graph (det 0.4 MB, rec 5 MB) on CPU, with the OpenCV/PDFium post-processing that
makes reading order, headings, lists and tables come out as markdown. ~76 MB of weights on first run, cached after, no
network at all once cached.

It runs **in the tool machine**, not as an MCP service, and that is the whole argument: the file is already there. A
photo of her конспект is on the inbox volume, the tool machine has it at the same path, and `indra-ocr <path> --format
md` is one process away — no upload, no second copy, no service to reach over a network. An MCP hop would buy nothing
and cost a container.

- Install: `pip install indra-ocr` in `deploy/env.Dockerfile` (Ubuntu wheels exist; the Nix packaging exists because
  NixOS has no usable `opencv-python-headless`, which is not true here), with the weights fetched at build time so the
  first request is not the slow one and the image works with the network down.
- Reaching for it is a **skill**, not new code: «PDF, скан или фото страницы — сначала `indra-ocr <path> --format md`,
  потом работай с текстом; если это рукопись — проверь по картинке слова, в которых OCR уверен плохо».
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

- **One place for models.** OCR, ASR and any embedding model live in one capability stack on the host with its own
  compose file, reached by each mason stack over a shared network. Not per bot.
- **Reachability without host ports.** A service joins the bot's `mcp` network under a stable alias, so no port is
  published and no other tenant of the host can reach it. Where a published port is unavoidable, it binds loopback and
  carries a token of its own.
- **The trust boundary moves, and has to be redrawn.** Every capability added is a new way for text from a stranger to
  reach a process: a fetched page, a transcript, an OCR of a photographed page. Two rules survive all of them: files and
  pages are data, never instructions; and a capability that fetches has an allowlist, because the container it runs in
  can reach the host's private network.
- **Per-bot opt-in is the default.** `integrations.json` is per stack, so a capability lands on the bot that needs it.
  Таня gets search and ASR; a bot that only reports issues does not pay for either.
- **Cost is stated before a capability is added**, in tokens per turn and in money per month, in the commit that adds it.

## What "done" means per capability

A capability is not shipped when the tool answers. It is shipped when: the model reliably reaches for it without being
told (the description is the trigger), a failed call degrades to a sentence a person understands, it costs what the plan
said it would, and one test in the repo fails if it disappears.
