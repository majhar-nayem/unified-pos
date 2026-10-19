# syntax=docker/dockerfile:1.7
# One Dockerfile for every deployable. Build from the repository root:
#   docker build -f infra/docker/Dockerfile --target runtime --build-arg APP=api    -t pos/api .
#   docker build -f infra/docker/Dockerfile --target runtime --build-arg APP=worker -t pos/worker .
#   docker build -f infra/docker/Dockerfile --target migrate -t pos/migrate .
# APP is the directory under apps/ (api, worker, payments).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

# --- Amazon RDS CA bundle: Aurora enforces TLS (rds.force_ssl) and Node does not trust the RDS CA by default ----
FROM base AS rds-ca
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

# --- full workspace with every dependency -------------------------------------------------------
FROM base AS source
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- migrations: the db package, its SQL and tsx (runs `pnpm --filter @pos/db migrate`) -----------
FROM source AS migrate
RUN pnpm --filter "@pos/db..." build
COPY --from=rds-ca /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem
USER node
CMD ["pnpm", "--filter", "@pos/db", "migrate"]

# --- build one app and assemble a production-only tree (workspace packages are copied, not linked) ---
FROM source AS build
ARG APP
RUN test -n "$APP" || (echo "build-arg APP is required (api, worker, payments)" && exit 1)
RUN pnpm --filter "@pos/${APP}..." build
RUN pnpm --filter "@pos/${APP}" deploy --prod /deploy

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
COPY --from=rds-ca /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /deploy /app
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
