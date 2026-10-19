# self-hosted single-process shape: bun + sqlite + the built viewer
FROM oven/bun:1
WORKDIR /app
COPY server.ts package.json ./
# mount or copy the viewer build (tools/share-viewer/dist) at /app/../share-viewer/dist
# or set VIEWER_DIR; simplest: COPY ../share-viewer/dist ../share-viewer/dist at build time
ENV OPENSHARE_DB=/data/openshare.db
VOLUME /data
EXPOSE 8787
CMD ["bun", "server.ts"]
