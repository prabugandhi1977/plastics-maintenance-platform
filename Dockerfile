# Plastics maintenance platform: API, web workspace and field app in one container.
# Data (SQLite database and uploads) lives on the /data volume; mount persistent storage there.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production PORT=3100 MOULDCARE_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api ./api
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN rm -rf api/tests && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to fix /data ownership, then runs as "node". Migrations run on start; demo data only when
# MOULDCARE_SEED_DEMO=true; the first real admin comes from MOULDCARE_ADMIN_EMAIL/PASSWORD. NODE_ENV=production makes
# the server refuse a missing or short MOULDCARE_SECRET.
ENTRYPOINT ["docker-entrypoint.sh"]
