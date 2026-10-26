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
