# The Telegram integration's image: the package as it runs, no build step.
#
# TypeScript from source on Node 22 (`--experimental-strip-types`), which is the repository's own rule for everything it
# runs, and the reason there is no `tsc` here: a compiled copy would be a second artefact to keep in step with `src/`,
# and the compiler's job is done by `npm run typecheck` where a person can read it.
#
# Published on its own (ghcr.io/denissud/mason-telegram), never as part of mason's image: an integration has its own
# release cycle, and mason's only knowledge of it is the URL in integrations.json and a trigger secret.
FROM node:22-bookworm-slim

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

USER node

# Documentation, not a route: nothing publishes this port, and mason reaches it by name on mason-mcp.
EXPOSE 8082

CMD ["node", "--experimental-strip-types", "src/main.ts"]
