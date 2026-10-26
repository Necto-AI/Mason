# The Telegram integration's image: the package as it runs, no build step.
#
# TypeScript from source on Node 22 (`--experimental-strip-types`), which is the repository's own rule for everything it
# runs, and the reason there is no `tsc` here: a compiled copy would be a second artefact to keep in step with `src/`,
# and the compiler's job is done by `npm run typecheck` where a person can read it.
#
# Published on its own (ghcr.io/denissud/mason-telegram), never as part of mason's image: an integration has its own
# release cycle, and mason's only knowledge of it is the URL in integrations.json and a trigger secret.
# Qualified for the same reason as the node image in deploy/mason.Dockerfile: no short-name resolution on a NixOS
# podman host, and this image is built by the same compose file.
FROM docker.io/library/node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# The trigger face's only state. A volume is mounted over it in the compose file; the directory is created here so the
# image also runs without one, and owned by the unprivileged user that writes it.
RUN mkdir -p /data && chown node:node /data

# The agent's inbox: where an incoming file lands, and the only directory of the agent's home this container can see. The
# compose file mounts a volume here at the same path it is mounted at in the tool machine, which is what makes the path in
# an event open the same bytes on both. Everything else of the home — the profile, the log, the skills, the memory
# repository — does not exist in this image at all.
RUN mkdir -p /home/mason/.mason/agent/workspace/inbox && chown node:node /home/mason/.mason/agent/workspace/inbox

USER node

# Documentation, not a route: nothing publishes this port, and mason reaches it by name on mason-mcp.
EXPOSE 8082

CMD ["node", "--experimental-strip-types", "src/main.ts"]
