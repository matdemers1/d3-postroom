# syntax=docker/dockerfile:1.7
# One image for every home daemon (PST-ADR-001, PST-REQ-004): `postroom <daemon>` picks the
# entrypoint. Build from the repo root: docker build -t postroom .

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.34.5
WORKDIR /repo

# Fetch from the lockfile alone so dependency layers survive source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm -r build
# Drop dev dependencies. The release-age policy gates *resolving* versions on a developer's
# machine; this reproduces a lockfile that already passed it, so the check is off here only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --offline --frozen-lockfile --config.minimum-release-age=0 \
    && find apps packages -mindepth 2 -maxdepth 2 \( -name src -o -name test \) -type d -prune -exec rm -rf {} + \
    && rm -rf fixtures fuzz security docs e2e .github

FROM ${NODE_IMAGE} AS runtime
# pg_dump/pg_restore for backups and the restore drill. The client major must match the server's
# (16): a newer pg_dump writes `SET transaction_timeout`, which a 16 server refuses on restore — the
# lesson D3 Auth and Foreman both paid for. PGDG's key ships inside Debian's postgresql-common.
ARG POSTGRES_MAJOR=16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-client-${POSTGRES_MAJOR} \
    && rm -rf /var/lib/apt/lists/* \
    && pg_dump --version | grep -q " ${POSTGRES_MAJOR}\." \
    && pg_restore --version | grep -q " ${POSTGRES_MAJOR}\."
ARG REVISION=dev
ENV NODE_ENV=production POSTROOM_REVISION=${REVISION} WEB_DIST=/app/apps/web/dist \
    BLOB_DIR=/var/lib/postroom/blobs BACKUP_DIR=/var/lib/postroom/backups
WORKDIR /app
# Code stays root-owned so the service user cannot modify it; only the data dirs are writable.
COPY --from=build /repo ./
RUN mkdir -p /var/lib/postroom/blobs /var/lib/postroom/backups \
    && chown -R node:node /var/lib/postroom \
    && ln -s /app/bin/postroom.mjs /usr/local/bin/postroom
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 CMD ["node", "/app/bin/healthcheck.mjs"]
ENTRYPOINT ["node", "/app/bin/postroom.mjs"]
CMD ["api"]
