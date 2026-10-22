# syntax=docker/dockerfile:1.7
FROM node:24.22.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /src/PluHub
COPY . .
COPY --from=spec . /src/PluHub-Spec
COPY --from=plugins . /src/PluHub-Plugins
RUN pnpm bootstrap && pnpm build:all && pnpm pack:all && node deploy/docker/prepare.mjs

FROM node:24.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production PLUHUB_CONFIG=/data/pluhub.json
WORKDIR /opt/pluhub
COPY --from=build /image/ ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund ./packages/*.tgz \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "deploy/docker/healthcheck.mjs"]
ENTRYPOINT ["sh", "deploy/docker/entrypoint.sh"]
CMD ["start"]
