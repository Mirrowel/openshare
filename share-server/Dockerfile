# Open(code)Share portable server — one image, server + viewer.
# Build from the REPO ROOT (the viewer sources live beside this file):
#   docker build -f share-server/Dockerfile -t openshare .
# Run:
#   docker run -e CREATE_TOKEN=root-secret -p 8787:8787 -v oshdata:/data openshare

# ---- stage 1: build the viewer (vite needs node) --------------------------
FROM node:20-alpine AS viewer
WORKDIR /build
COPY share-viewer/package.json share-viewer/package-lock.json ./
RUN npm ci
COPY share-viewer/ ./
RUN npm run build

# ---- stage 2: the bun runtime ---------------------------------------------
FROM oven/bun:1-alpine
WORKDIR /app
COPY share-server/server.ts share-server/package.json ./
COPY --from=viewer /build/dist /share-viewer/dist
ENV OPENSHARE_DB=/data/openshare.db \
    VIEWER_DIR=/share-viewer/dist
VOLUME /data
EXPOSE 8787
CMD ["bun", "server.ts"]
