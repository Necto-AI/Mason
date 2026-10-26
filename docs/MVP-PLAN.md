# Proving the MVP: clinical-compass through the Telegram bot

> Written 2026-10-26. The first real use case is Denis's own project, with the bot as the only interface. This is the
> plan for finding out whether that is worth using, in a week, without mistaking a demo for a product.

## The claim under test

One sentence, so the test can fail: **a chat with the bot is a faster way to keep clinical-compass's notes, ideas and
specifications moving than opening a laptop and doing it by hand.**

Everything below exists to produce evidence for or against that sentence. It is not a feature checklist.

## What the agent can reach, and why each one matters

| Reach | Why the test needs it |
|---|---|
| The repository at `/home/user/dev/clinical-compass`, read-write, `gh` authenticated as Denis | A note becomes a spec becomes an issue, and the agent does the mechanical part |
| The Obsidian vault at `/home/user/Documents/Notes` | The notes already exist, and an idea captured nowhere is lost. Proposed mount: `projects/clinical-compass/` writable, the rest read-only |
| The tool machine's own Linux | `rg`, `jq`, `python`, `git`, a browser — the things a person would use |
| Telegram: files in, messages out | A photo of a whiteboard and a PDF of a paper are how the material actually arrives |
| Its own memory | It should not ask who the patient cohort is every morning |

Not in scope for the MVP: the Yandex integrations ([research](../research/yandex-integrations/), plan not yet written),
proactivity beyond one daily routine, and any UI other than the chat.

## The test ladder

Four rungs, each with an exit gate. A rung that fails is fixed before the next one is attempted; a rung that passes
twice in a row is done.

### Rung 0 — the pipe (minutes)

Already green on the deployed instance: message in, event fired, turn run, reply out, typing dots shown, a tool used
(`gh`), internet reached. What is **not** yet proven end to end: a file from Telegram actually landing in the inbox and
being read. That is the first thing to do, with a PDF and a photo.

Gate: the bot describes the contents of a PDF it was sent, and the path it names exists in the tool machine.

### Rung 1 — the ten scripted conversations (an hour)

Each is a real request, sent to the bot the way Denis would send it, judged against a written pass criterion. Run them
in a fresh conversation, then again after `/compact`, because a compacted context is where agents usually fall apart.

| # | Send | Passes when |
|---|---|---|
| 1 | *"Capture: the trial should ask the clinic's own staff to rate the queue times, not just patients."* | A note appears in the vault's `projects/clinical-compass/` with that idea, dated, in Denis's voice, and the bot says where it put it |
| 2 | *"What's the state of the watch feature?"* | Answers from the repository (ADRs, recent commits) and the issues, cites both, no invention |
| 3 | *(a PDF of a paper)* *"Anything here we should adopt?"* | Reads the file, names two concrete things, says which are out of scope for clinical-compass |
| 4 | *"Turn yesterday's note about triage into a spec."* | Drafts a spec in the repo's own format, does not open a PR without asking |
| 5 | *"Open an issue for the retry bug in the sync worker, with what we know."* | Issue opened on GitHub with a useful body, and the URL returned |
| 6 | *"What did I decide about pricing in September?"* | Answers from the vault or the transcript with the file it came from, or says it does not have it |
| 7 | *"Write me a landing page headline."* / then *"shorter"* / then *"shorter"* | Three replies that are three different headlines, not a paragraph explaining the trade-offs |
| 8 | A long task (*"read the three ADRs and tell me what contradicts the current design"*), then `/stop` mid-run | Stops within a second, says what it had done, and the next message works normally |
| 9 | `/compact`, then *"and what about the second one?"* | The summary kept the thread: the answer is about the second ADR |
| 10 | *"You were wrong about X."* | Accepts it, rechecks, says what it got wrong — no defensiveness, no re-litigating |

Rung 1 gate: **8 of 10 pass.** Any failure is either fixed or written down as a known limit before rung 2.

### Rung 2 — the pilot week (seven days)

One routine, no other proactivity: a morning message at 08:30 with yesterday's activity in the repo (commits, issues
opened or closed, anything the agent did) and one suggestion. Everything else comes from Denis.

What is measured, without asking him to journal anything:

- **Messages sent by him per day**, and how many were re-sent or corrected. A correction rate above one in five means
  the agent's first answer is not usable.
- **Turn cost and latency**, from the event channel once milestone 2 of [`BACKEND-PLAN.md`](BACKEND-PLAN.md) lands. Until
  then, from the provider's own dashboard: tokens per day.
- **Files and messages where the agent had to say "I cannot"**, and why (no tool, no permission, no data).
- **The morning message**: was it read, was it useful, did he ask for it to stop. Silence about it after three days is a
  no.

Rung 2 gate: **the week is used on at least five days, and no message is muted.** If he stops opening it, the claim under
test is false and the next thing to build is not on this list.

### Rung 3 — the handover (the point of the exercise)

The real test of an assistant is what happens when he is not there: leave it for three days with the morning routine on
and nothing else, then read what it did without prompting.

Gate: at least one message in those three days that he acted on, and zero that were noise. That is the sentence from
[`BACKEND-PLAN.md`](BACKEND-PLAN.md) §3, measured.

## What would make us stop

Written down before the results, so a good week cannot talk us into a bad product:

1. Denis drafts the message himself more than half the time, because it is faster.
2. Two consecutive days where the only thing it did was answer questions it could have answered from a search.
3. The morning routine produces something he skims and closes, three days running.
4. A turn costs more than the work it saves, measured in minutes of his attention rather than in tokens.

## Mechanics of running it

- **One chat, one identity.** `TEAM=Denis`, the DM chat id, no group. A group is a later test: it changes who the agent
  is speaking to, which is the interesting question and not this one.
- **The vault is the record.** Everything the agent writes goes where a person would have written it, so the test also
  says whether its filing is good enough to live with.
- **A bug file, not a wish list.** Every failure goes into `docs/research/mvp-log.md` with the message, the answer and
  one line of what should have happened. This is the input to the next milestone, and it is the only artefact the pilot
  is required to produce.
- **The instance is the deployment.** No local run, no second bot: the pilot runs on the pc host, deployed by
  `deploy/deploy.sh`, because a bug that only exists in the deployment is the bug worth finding.

## What the pilot is expected to teach, in priority order

1. Whether the tool machine is fast enough to be a colleague. Every turn crossing SSH into a container has a cost a
   person feels, and [`ENV-PLAN.md`](ENV-PLAN.md) is the answer to it if the answer is "no".
2. Whether files and notes are the right interface, or whether the agent should be reading the repo and the vault on its
   own initiative instead of being handed things.
3. Which of the ten scripted conversations are actually the daily ones. The set above is a guess; the pilot replaces it
   with data.
