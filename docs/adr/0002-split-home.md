# The home is split: service-owned state on the server, agent-owned state on the tool machine

**Status:** Accepted

The bot's files must be editable with ordinary tools — `read`, `write`, `bash`, and its own skills — which means they
have to live on the machine those tools run on, not in the process that thinks. But the same directory also holds the
connector credential hashes, the integration secrets, the SQLite database, the SSH key and a copy of the provider
credential, so moving the home wholesale would hand the bot its own door and its own model key.
The home is therefore split into `agent/` (mounted into the tool machine, read and written by the bot) and `service/`
(never mounted, never a path inside the tool machine), and the split is a volume boundary rather than a permission
mode because `bash` can talk its way around a mode.

## Consequences

- **The server reads `agent/` through the execution environment**, not through `node:fs`: the same `RemoteExecutionEnv`
  the tools use. `service/` is read directly by the server and stays invisible to every tool.
- **Reads are snapshotted per turn and never retried inside one.** A read that fails keeps the previously shown text
  rather than blanking the prompt, and costs one failed round trip per turn rather than one per model request. On the
  first turn of a conversation there is no previously shown text to keep, so the section is simply absent from that
  turn's prompt; the next turn reads the file again.
- **`soul.md` is service-owned and simply not readable by the bot.** No read-only copy, no mode bit; the file is not
  in the bot's world at all.
- **A pre-split home is refused, not migrated.** `refuseLegacyHome` names the entries it found and says to move them
  into `agent/` or `service/` by hand. A server that rewrote an operator's home on boot would be a server that edits
  files he did not ask it to touch, and one migration engine is a programme of its own.
