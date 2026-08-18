# syntax=docker/dockerfile:1
#
# Two stages: a build stage with the full toolchain, and a runtime stage that
# carries only what `node dist/main.js` actually needs.
#
# Three things about this project shape the file and are easy to undo by
# accident:
#
# 1. The Prisma client is generated to `/app/generated/prisma`, NOT into
#    node_modules — see the `output` in prisma/schema.prisma. `dist/prisma/
#    client.js` resolves `../../generated/prisma/client`, so that directory
#    must sit beside `dist` at runtime or the app dies on its first import.
# 2. `prisma.config.ts` is a TypeScript file and `tsx`/`typescript` are dev
#    dependencies, so it cannot be loaded in the runtime stage. It is the only
#    thing that supplies the datasource URL (the `datasource` block has no
#    `url` — Prisma 7 driver adapter). **Migrations therefore cannot be run
#    from this image**; the CD pipeline runs them from the runner, which has
#    the dev dependencies. See .github/workflows/deploy.yml.
# 3. Husky's `prepare` script runs on `npm ci` and fails without a .git dir,
#    which is why HUSKY=0 is set in both stages.

# =========================
# Stage 1: Build
# =========================
FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV HUSKY=0

# Copy manifests first so the dependency layer caches independently of source.
COPY package*.json ./
RUN npm ci

# Source. `.dockerignore` keeps tests, docs and local runtime dirs out.
COPY . .

# Generate into /app/generated/prisma per the schema's `output`.
#
# The placeholder DATABASE_URL is required, and is not a shortcut.
# `prisma.config.ts` resolves the datasource with Prisma's `env()` helper,
# which THROWS when the variable is missing — and `.env` files are excluded
# from the build context on purpose, so nothing supplies it here. Generation
# never opens a connection; it only needs the value to resolve. Without this
# the build dies with `PrismaConfigEnvError: Cannot resolve environment
# variable: DATABASE_URL`.
#
# Set inline on the command rather than as an ENV so the placeholder lives
# for exactly one layer and cannot be mistaken at runtime for a real URL.
RUN DATABASE_URL="postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder" \
    npx prisma generate

RUN npm run build

# Drop dev dependencies in place rather than reinstalling in the runtime
# stage. `npm ci --omit=dev` there would re-resolve the tree and could pull a
# different transitive set than the one just built and tested against.
RUN npm prune --omit=dev


# =========================
# Stage 2: Runtime
# =========================
FROM node:22-bookworm-slim AS production

WORKDIR /app
ENV NODE_ENV=production \
    HUSKY=0 \
    PORT=3000 \
    HOST=0.0.0.0

# curl is for the HEALTHCHECK below; nothing else needs it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the exact artefacts the build produced, rather than rebuilding them.
# Regenerating the Prisma client here would need prisma.config.ts, which
# cannot be loaded without the dev dependencies (see note 2 at the top).
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/generated ./generated
COPY --from=builder --chown=node:node /app/dist ./dist
# Carried for reference and for anyone running migrations with a shell in the
# container that also has the dev toolchain mounted. Small, and its absence is
# confusing when debugging.
COPY --from=builder --chown=node:node /app/prisma ./prisma

# The base image ships an unprivileged `node` user. Running as root means a
# container escape starts as root, and nothing here needs the privilege.
USER node

EXPOSE 3000

# The path mirrors main.ts: API_PREFIX/API_VERSION default to api/v1, and the
# health controller is mounted at `health` beneath that. `--fail` makes curl
# exit non-zero on a 4xx/5xx, which is what the healthcheck reads.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl --fail --silent "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

# NOTE THE PATH: `dist/src/main.js`, not `dist/main.js`.
#
# tsconfig.json sets no `include`/`rootDir`, so `prisma.config.ts` and
# `prisma/seed.ts` are part of the compilation and the common source root
# becomes the repository root — which pushes the app one level down, to
# `dist/src/`. `npm run start:prod` (`node dist/main`) still points at the old
# path and throws MODULE_NOT_FOUND; so did this Dockerfile before this change.
# Fixing it properly means excluding those two files in tsconfig.build.json,
# which moves the output back to `dist/main.js` — but that also changes the
# path the EC2 pm2 process is configured against, so it is left alone here
# rather than changed as a side effect of a Docker fix.
#
# `--init` (or an orchestrator that reaps) is recommended when running this:
# node as PID 1 does not reap zombies. The exec form below at least ensures
# SIGTERM reaches node rather than a shell.
CMD ["node", "dist/src/main.js"]
