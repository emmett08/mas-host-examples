# Build the independently maintained, pinned host rather than copying protocol code.
FROM rust:1.99.0-bookworm AS host
WORKDIR /build
COPY host-revision.txt /build/host-revision.txt
RUN git clone https://github.com/emmett08/mas-host.git source \
    && git -C source checkout --detach "$(cat host-revision.txt)" \
    && cargo build --release --locked --manifest-path source/Cargo.toml -p mas-host

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY examples/k3s-live/package.json examples/k3s-live/package-lock.json ./
RUN npm ci
COPY examples/k3s-live/ ./
RUN npm test && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 demo && useradd --uid 10001 --gid demo --create-home demo
WORKDIR /app
COPY --from=host /build/source/target/release/mas-host /opt/mas-host/mas-host
COPY --from=web --chown=10001:10001 /app/dist ./dist
COPY --from=web --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=web --chown=10001:10001 /app/package.json ./package.json
COPY --chown=10001:10001 examples/k3s-live/project ./project
COPY --chown=10001:10001 examples/k3s-live/deploy/probe-app.mjs ./deploy/probe-app.mjs
COPY --chown=10001:10001 examples/k3s-live/deploy/remediation.mjs ./deploy/remediation.mjs
RUN mkdir /data && chown demo:demo /data /app/project
ENV MAS_HOST_BIN=/opt/mas-host/mas-host MAS_SDK_ROOT=/opt/mas-host \
    DEMO_DATA_DIR=/data LISTEN_HOST=0.0.0.0 PORT=8080
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
