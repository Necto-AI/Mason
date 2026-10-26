# An integration is a service with two halves: a tool surface and a trigger

mason is meant to carry many integrations, so per-integration code in the server does not scale — every new system
would mean a TypeScript module, a test and a review. An integration is therefore a separate process with at most two
network faces: an MCP endpoint over Streamable HTTP that lends the bot tools, and one authenticated POST that wakes it
with events. The server holds a single generic adapter for both — one MCP client, one event door — and everything that
differs between integrations is configuration read at boot. An integration is neither a pi-durable extension nor a
client: an extension is per-conversation, per-turn code with no lifecycle, and a client is a device that speaks in the
room, while an integration does background ingest and must never speak.

## Consequences

- **The event envelope is a public contract.** The server no longer parses vendor payloads, so the shape of an event,
  its signature (HMAC over the raw body), its dedupe id and its version (`v1`) have to be stable before the first
  third-party integration ships.
- **The enabled set is resolved at boot.** Changing it is a restart, so the tool surface and the prompt section stay
  byte-identical between turns and no reconnect can re-price the prefix mid-conversation.
- **Every integration is optional by default.** A container that is down removes its tools and says so in the log and
  in `/api/integrations`; it does not refuse the boot.
- **`connector` retires as a noun.** The inbound door is `integration.trigger`; the thing a trigger fires is still a
  hook, and the thing a tool call reaches is still the tool machine.
- **The integration owns its upstream credential.** The PAT, bot token or OAuth client lives in the container that
  talks to the system; mason holds only the MCP URL and that integration's trigger secret. This reverses the earlier
  "mason owns the upstream credential" decision in #41 — a service that must be taught to authenticate is not a
  generic adapter.
- **No extension is written per integration.** The only per-integration artefacts are a container, a config entry and
  a secret.
- **ADR-0004 extends that list with one hook.** A hook's `promptTemplate` is where interface-specific prompt text
  belongs, so the suite is a container, a config entry, a secret and a hook — and nothing else in `src/` may know an
  interface's name (`docs/adr/0004-mason-is-a-headless-backend.md`).
