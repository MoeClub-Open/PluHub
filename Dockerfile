# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b AS bun
FROM node:24.22.0-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /src/PluHub
COPY . .
COPY --from=spec . /src/PluHub-Spec
COPY --from=plugins . /src/PluHub-Plugins
RUN pnpm bootstrap && pnpm build:all && pnpm pack:all && node deploy/docker/prepare.mjs
RUN cd /image && npm install --omit=dev --ignore-scripts --no-audit --no-fund ./packages/*.tgz

FROM bun AS runtime
ENV NODE_ENV=production PLUHUB_CONFIG=/data/pluhub.json BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
LABEL io.pluhub.runtime=bun io.pluhub.runtime.version=1.4.3
WORKDIR /opt/pluhub
COPY --from=build /image/ ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "deploy/docker/healthcheck.mjs"]
ENTRYPOINT ["sh", "deploy/docker/entrypoint.sh"]
CMD ["start"]
