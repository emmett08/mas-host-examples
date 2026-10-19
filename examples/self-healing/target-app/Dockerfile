# Standalone app build. The repair executor uses the stricter trusted builder.
FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=10001:10001 package.json config.json ./
COPY --chown=10001:10001 src ./src
USER 10001:10001
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/server.ts"]
