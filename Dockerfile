# Plastics maintenance platform: API, web workspace and field app in one container. MouldCare Monitor (monitor/) is built
# in too and only starts when MONITOR_EMBED=true; it is then served under /monitor (see docker-entrypoint.sh).
# The database is PostgreSQL (set DATABASE_URL). Uploaded files live on the /data volume; mount persistent storage there.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production PORT=3100 MOULDCARE_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY monitor/package.json monitor/package-lock.json ./monitor/
RUN cd monitor && npm ci --omit=dev && npm cache clean --force
COPY backend ./backend
COPY frontend ./frontend
COPY monitor/server ./monitor/server
COPY monitor/web ./monitor/web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN rm -rf backend/tests frontend/scripts && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to fix /data ownership, then runs as "node". Migrations run on start; demo data only when
# MOULDCARE_SEED_DEMO=true; the first real admin comes from MOULDCARE_ADMIN_EMAIL/PASSWORD. NODE_ENV=production makes
# the server refuse a missing or short MOULDCARE_SECRET.
ENTRYPOINT ["docker-entrypoint.sh"]
