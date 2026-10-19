# MouldCare Monitor: API, dashboard and gateway intake in one container. Build from this folder:
#   docker build -t mouldcare-monitor . && docker run -p 3300:3300 -v monitor-data:/data --env-file .env mouldcare-monitor
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production PORT=3300 MONITOR_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY web ./web
RUN mkdir -p /data && chown node:node /data
EXPOSE 3300
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to make a mounted /data writable, then runs as the unprivileged "node" user.
ENTRYPOINT ["sh", "-c", "chown -R node:node /data && exec su-exec node node server/index.js"]
