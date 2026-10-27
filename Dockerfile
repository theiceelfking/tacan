# Catan room/relay server + Unity WebGL build in one image.
#   npm run sync-web            # copy ../Builds/Web into public/
#   docker build -t catan-server .
#   docker run -p 8080:8080 -v catan-data:/data catan-server   # accounts live in the volume
FROM node:22-alpine

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "src/index.js"]
