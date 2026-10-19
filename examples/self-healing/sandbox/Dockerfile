# Trusted setup builds this once, then freezes its immutable image ID.
# Candidate files, Dockerfiles and package scripts are absent during setup.
FROM node:24-bookworm-slim
RUN test -x /usr/bin/timeout && mkdir /app && chown 10001:10001 /app
WORKDIR /app
USER 10001:10001
CMD ["node", "--experimental-strip-types", "src/server.ts"]
