# The home is split: service-owned state on the server, agent-owned state on the tool machine

The bot's files must be editable with ordinary tools — `read`, `write`, `bash`, and later its own skills and
extensions — which means they have to live on the machine those tools run on, not in the process that thinks. But the
same directory today also holds the pairing-token hashes, the connector secrets, the SQLite database, the SSH key and a
copy of the provider credential, so moving the home wholesale would hand the bot its own door and its own model key.
The home is therefore split into `agent/` (mounted into the tool machine, read and written by the bot) and `service/`
(never mounted, never a path inside the tool machine), and the split is a volume boundary rather than a permission
mode because `bash` can talk its way around a mode.

## Consequences

- **The server reads `agent/` through the execution environment**, not through `node:fs`: the same `RemoteExecutionEnv`
  the tools use. `service/` is read directly by the server and stays invisible to every tool.
- **Reads are snapshotted per turn and never retried inside one.** A read that fails keeps the previously shown text
  rather than blanking the prompt, and costs one failed round trip per turn rather than one per model request.
- **`soul.md` is service-owned and simply not readable by the bot.** No read-only copy, no mode bit; the file is not
  in the bot's world at all.
- **The layout change is a one-time, re-runnable migration** (`npm run doctor -- migrate`) that moves files with `git
  mv` inside the home's own repository, so it can be inspected and reverted like any other commit.
