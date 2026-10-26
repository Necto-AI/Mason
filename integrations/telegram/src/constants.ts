/**
 * The numbers and paths this container is held to, in one place.
 *
 * The port and the MCP path are half of mason's knowledge of this container: `integrations.json` points at
 * `http://mason-telegram:8082/mcp`, so moving either here without the other end is an integration whose tools vanish
 * with a connection error at boot. The data directory is the volume the compose template mounts, and nothing outside it
 * is state.
 */

/** The MCP path. `/mcp` on every integration, so one URL shape is what an operator remembers. */
export const MCP_PATH = "/mcp";

/** The tools face's port, and the default when `PORT` is not set. */
export const DEFAULT_MCP_PORT = 8082;

/** The trigger face's volume: `offset.json` and `chats.json`, and nothing else. */
export const DEFAULT_DATA_DIR = "/data";

/**
 * Where an incoming file is written, and the one directory of the agent's home this container sees.
 *
 * The value is a directory both containers mount at this same path — `mason-inbox` in the compose files — so a path in a
 * payload opens the same file in the tool machine the agent's `read` runs in. Moving it here means moving the mount in
 * `deploy/compose.yaml` too, and moving it in one place only is an inbox the agent cannot open.
 */
export const DEFAULT_INBOX_DIR = "/home/mason/.mason/agent/workspace/inbox";
/**
 * The longest `TELEGRAM_INBOX` the door could still be told about. Every payload carrying a file ends with this path, and
 * the door refuses a payload over 2 000 characters rather than cutting it, so a directory name that does not fit is a
 * stack where the file clause has to be dropped for every message.
 */
export const INBOX_PATH_MAX_BYTES = 512;

/**
 * How long a voice note may wait for its transcript before the message goes on without one.
 *
 * The poller prepares a message before it posts it, so a transcription holds the rest of the batch behind it. Twenty
 * seconds is longer than a minute of speech takes on a CPU and short enough that a service which is down costs one
 * message's delay rather than the chat's morning — the long poll itself is half a minute.
 */
export const ASR_TIMEOUT_MS = 20_000;

/**
 * The largest file worth posting, in MiB. Telegram lets a bot download 20 MiB, but a voice note is speech, and speech is
 * a few hundred kilobytes a minute: this is roughly a quarter of an hour of talking. A file past it is a recording — an
 * `audio` that is a podcast, not a message — and the round trip would be spent for a transcript longer than the door's
 * payload could carry.
 */
export const ASR_MAX_MIB = 4;
export const ASR_MAX_BYTES = ASR_MAX_MIB * 1024 * 1024;

/**
 * How much of an answer is kept as the transcript. `renderPayload`'s cap is 2 000 characters, so anything longer is going
 * to be cut there anyway; this only keeps a service that answers with a whole document from making this container hold
 * it.
 */
export const ASR_TEXT_MAX = 4_000;
