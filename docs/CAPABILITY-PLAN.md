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

## The four layers, and what goes in each

| Layer | What it is | Fits |
|---|---|---|
| **pi's own tools** | the tool machine: `bash`, `read`, `write`, `edit`, plus pi's web tools when enabled | anything that is a process on a machine: counting a table, converting a file, reading a page |
| **MCP integration** | a service with an endpoint, declared in `service/integrations.json`: one line of description, tools under `mcp__<name>__*` | models: ASR, OCR, embeddings; anything with weights, GPU or state |
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

### Phase 3 — OCR, and the vision question

Photographs of конспекты, scans of методичек, screenshots of заданий, PDFs of articles.

- Two different problems wear one name: **printed text** (PDF, screenshots — a text layer or a cheap OCR pass) and
  **handwriting** (her notes, a photographed page). The second is where tesseract fails and a vision model wins.
- Decide once: a vision-capable model as the default reader (fewer moving parts, one tool), or an OCR service for
  documents plus a vision model only for handwriting. The answer depends on what the provider actually accepts as an
  image and what the host can run.
- Done when a photograph of a handwritten page comes back as structured text with the uncertain words marked, not
  silently guessed.

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
