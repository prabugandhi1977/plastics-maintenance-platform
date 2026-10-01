# Plastics maintenance platform: API, web workspace and field app in one container.
# Data (SQLite database and uploads) lives on the /data volume; mount persistent storage there.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3100 MOULDCARE_DATA_DIR=/data
COPY package.json ./
COPY api ./api
COPY web ./web
RUN rm -rf api/tests && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run on start. Demo data only when MOULDCARE_SEED_DEMO=true; the first real admin comes from
# MOULDCARE_ADMIN_EMAIL/PASSWORD. NODE_ENV=production makes the server refuse a missing or short MOULDCARE_SECRET.
CMD ["sh", "-c", "if [ \"$MOULDCARE_SEED_DEMO\" = \"true\" ]; then node api/seed.js; fi && node api/bootstrap-admin.js && exec node api/server.js"]
