# Brief: prompting a model to run its own harness

Date: 2026-11-05. Reader: Denis, who runs a pi-based agent setup (markdown skills under
`~/.pi/.../skills`, subagents, codemode tools) and is designing the self-improvement layer for it.
He builds toys to understand mechanisms; he does not want a framework to copy.

## The question, in one sentence

Which prompt-level mechanisms actually make a model use the self-improvement affordances it is given
(writing a skill, extending itself with a small tool/script, maintaining a `profile.md` of the user,
logging what it did, and retrieving those notes later), rather than ignoring them and answering from
the context window?

## What the answer is for

A design decision: what to put in the system prompt, what to make a tool, what to make automatic, and
what to leave out, for a harness where the model itself edits the files that steer it next session.
The reader will write prompt text from this. He is not choosing between products.

## What a good answer contains

1. **Verbatim prompt lines** that demonstrably drive adoption, with the file/URL they came from.
   Hermes Agent (NousResearch, open source) is the main worked example: it ships a system prompt that
   tells the agent to write skills, keep a character-budgeted memory, and patch its own skills, plus
   background nudges and a "curator" that prunes the skill library. Quote the actual sentences.
2. **The mechanisms, separated from the wording.** For each: what it is (index in the prompt, a tool
   whose description encodes the trigger, a read-back step the turn cannot skip, a background pass, a
   budget), why it works, and what it costs. The distinction that matters most: an artifact that is
   never read is never written, and a tool the model may choose to call is usually not called.
3. **The trigger wording.** Concrete before/after pairs where they exist: values ("be proactive")
   versus conditions ("when you finish a task that took more than three tries, write the procedure to
   a skill before replying"). Names of the events that fire a write.
4. **Evidence.** What has been measured, with numbers and the task. Voyager (skill library),
   Reflexion, SICA or another self-improving coding agent, ACE/agentic context engineering, MemGPT /
   Letta memory blocks, Generative Agents retrieval. Say which numbers are on toy benchmarks.
5. **Failure modes, with quotes.** Skill sprawl, prompt drift, self-written instructions that outrank
   the user, logs nothing retrieves, memory that grows until it crowds out the task, consolidation
   that merges the wrong things, reward hacking of the agent's own notes. Include what practitioners
   reported in 2025-2026 and what Hermes does about each (curator states, pinning, locking, budgets,
   no auto-delete).
6. **The `profile.md` / conventions-file question specifically.** Who writes it (model, person, both),
   when, what belongs in it versus a skill versus session history, and how conflicts with the current
   request are resolved. Compare at least: Claude Code's CLAUDE.md and its memory shortcut, the
   AGENTS.md convention, Hermes's "declarative facts, not instructions to yourself" rule, and the
   agentskills.io standard's file layout.
7. **A short "what I would write" section.** Ten to twenty lines of prompt text the reader could
   adapt, each line traceable to a finding above. Not a framework, not a schema dump.

## Scope edges

- In bounds: system prompt design, tool descriptions, context assembly, background/auxiliary passes,
  file formats for skills/memory/logs, retrieval at turn start.
- Out of bounds: fine-tuning, RL, weight-level self-modification, multi-agent orchestration for its
  own sake, product comparisons that do not show prompt text.
- "Hermez" in the original question is Hermes Agent (NousResearch). Treat it as one detailed case,
  not the whole answer.
- Sources that count as authoritative: the Hermes repo itself (code and docs), Anthropic's Skills and
  context-engineering posts, agentskills.io, the arXiv papers themselves, Letta/MemGPT docs, and
  first-person engineering writeups. A SEO blog summarising a paper is not a source for the paper's
  numbers.

## Practical notes for whoever reads this

- The Hermes docs site (`hermes-agent.nousresearch.com`) returns 403 to plain curl. The repo does
  not: `git clone --depth 1 https://github.com/NousResearch/hermes-agent` (about 400 MB, one or two
  minutes) or `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/<path>`. The full
  gold-plate system prompt for the CLI is at
  `tests/fixtures/prompt_surface/prompts/cli.hermes.txt`; docs live under `website/docs/user-guide/`.
- The web search backend in this setup is noisy (SearXNG, no date filter). Prefer fetching a page
  whose URL you already know, or a URL found via a repo/docs index, over trusting a snippet.
- Anthropic article pages are Next.js dumps: `curl -sSL --max-time 20 --compressed -A 'Mozilla/5.0'
  <url> | sed -e 's/<[^>]*>//g'` gets the body inside JSON, quotes still readable. arXiv `/abs/`
  pages are plain HTML and fetch fine.
- Every claim in the notes needs the URL it came from and, where it decides the answer, the sentence
  verbatim in quotes.
