# Transcription is a skill over a binary, not a service in the stack

**Status:** Accepted, 2026-11-11

`asr/` was a speech-to-text service of mason's own: Parakeet TDT v3 as three ONNX graphs on onnxruntime, its own
image, its own network memberships, one port, one POST. Nothing in the runtime called it, and nothing in the runtime
imported it. Its two consumers were the web panel's dictation button, deleted with the panel, and the Telegram relay,
deferred to v0.1.1. A service no code in the runtime reaches still pays for a network, a port and an authentication
boundary it does not need — on every deployment, and in every reading of the stack by somebody who assumes something
calls it.

**Decided:** speech-to-text, and OCR with it, are **skills over a binary in the execution environment**, not extra
services in the stack. A connector uploads the audio as an attachment (`POST /api/connector/attachments`, which the
agent reads itself when a message carrying one arrives), and a skill tells the agent to run a local transcriber over
the file it now holds. No port, no container, no second copy of the bytes, nothing to authenticate.

**Why not an MCP server.** mason's MCP surface is `mcp_search`, `mcp_describe` and `mcp_call`, and every one of them is
`callers: ["tools"]`: the model is never offered an MCP tool. An ASR server on `mason-mcp` would therefore be invisible
to the model, and reading a voice note would mean writing a script to call a tool the model was never told about. The
skill is the shorter path and the one the model can follow.

**The precedent.** `skills/ocr/SKILL.md` and `indra-ocr` in the env image: the binary is already on the machine the
tools run on, and the file is already at the path that machine can open. Transcription is the same shape with a
different binary, and it inherits the same properties — no network, no credential, no lifecycle of its own, and one
process that exits.

## Consequences

- `asr/`, the `mason-asr` service, the `asr-models` volume and `TELEGRAM_ASR_URL`'s default are gone. Nothing in this
  repository is a transcription service any more.
- The attachment path already carries the bytes to the tool machine; the skill reuses it rather than adding a channel.
- The skill ships in v0.1.1 with the Telegram connector, because that connector is its first consumer.
