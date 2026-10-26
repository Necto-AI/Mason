/**
 * The three numbers this container is held to, in one place.
 *
 * The port and the path are half of mason's knowledge of this container: `integrations.json` points at
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
