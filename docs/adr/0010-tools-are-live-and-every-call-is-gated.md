# 10. Tools are live, and every call passes one gateway

Date: 2026-11-02

## Context

Mason's tool surface was the prompt prefix. An integration's MCP server was reached once, at boot, and every tool it
offered became a deferred pi tool: not offered to the model until `tool_search` promoted it, but registered all the same.
That made three things true that should not be.

First, the `codemode` section renders the tools a script can call, so a server that redeployed mid-conversation changed
the prompt between two turns of one build and the cached prefix stopped being reusable. A container restarting was a
prompt invalidation.

Second, nothing decided whether a tool call was allowed. A server that lent `files.delete` lent it unconditionally, and
the model's choice to call it was the only gate there was. Approval was undefined, which is what blocked application
workflows: a bot that can submit an application needs someone to say yes to the submission, not a sentence in a prompt
asking it to be careful.

Third, a script could already reach any registered tool without declaring it, which is the useful half of code mode —
hand the model a filtered answer instead of 200 KB. That path had no more of a gate than the declared one.

## Decision

**Nothing a server says is a registered tool.** One `mcp` extension installs three fixed tools — `mcp_search`,
`mcp_describe`, `mcp_call` — and they are `callers: ["tools"]`, so a script reaches them and the model is never offered
them. They answer from a live catalog: re-listed on `notifications/tools/list_changed`, reconnected on the next question
after a drop, and versioned per definition so a call that names a version the server has since replaced is refused with
the rediscovery step instead of running against a replacement. The catalog is masonry's; the schemas never enter the
prefix.

**One gateway, before the intent.** A `permissions` extension installs one `beforeTool` hook on `ToolTask`. It is the
only seam that sees a model-issued call and a script's nested call with the same shape, and it runs before the call's
intent is committed — which is what makes a pending approval survive a restart, because a task that dies while waiting
has not recorded an intent and recovery re-enters the phase. `reply` to the turn's own origin is allowed and anything
else asks; an MCP call is decided by the tool's `dev.mason/approval` marker inside the operator's ceiling (`deny` beats
`ask` beats `allow`, and `required` always asks); everything mason ships is allowed, because gating `bash` is a separate
policy question.

**A question is durable and a person answers it.** An `ask` commits an `app.permission` entry and waits; the answer is an
`app.permission-answer` entry, allowed once, with no "always allow". A question is routed to the surface that started the
turn only when that person is the connector's configured approver; otherwise it stays pending and the owner answers it
through `/api/permissions`. A denial is a structured tool result. `stop` cancels the wait and records that it did.

## Consequences

- A server that redeploys, a container that restarts and a schema that changes move nothing the prompt is built from.
  The surface is the same bytes on every turn of one build, whatever answered at boot.
- An MCP tool with no marker now asks for approval where it used to run. That is deliberate — a server that said nothing
  about an operation has not said it is safe — and the operator's escape is a marker or `connector.trustMarkers`, not a
  silent default.
- Progressive disclosure is one level down: the model learns which services exist from the prompt, and a script asks what
  one of them can do. `tool_search` no longer has MCP tools to promote, which is the point.
- Approval authority is a grant on an entry, separate from the ability to speak. A person who can talk to the bot is not
  automatically a person who can approve an effect, and a display name never becomes one.
- `pi-durable` hands a hook the asking task's runtime, whose `commit` adopts the callback's return value as the task's own
  state. The gateway therefore commits through a `void`-typed wrapper: a read that returned its value from a hook would
  overwrite the task record with it.
