# Katalyst relayer — long-running process (cannot run on Vercel serverless).
# Build:  docker build -t katalyst-relayer relayer/
# Run:    docker run --env-file relayer/.env -p 8788:8788 -v katalyst-data:/app/data katalyst-relayer
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Verdict records are kept here; mount a persistent volume so they survive restarts.
ENV RELAYER_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 8788
USER node
CMD ["node", "dist/index.js"]
