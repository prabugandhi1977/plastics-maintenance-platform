# Virtual plant (and optionally its gateway). Build context is this folder:  docker build -t vplant simulator
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV EUROMAP_DIR=/data/euromap63
VOLUME /data
EXPOSE 1883 4840 4850
USER node
ENTRYPOINT ["node", "src/cli.js"]
CMD ["run", "--gateway"]
