# One image runs both processes: the Next.js web server (default CMD) and the
# WhatsApp worker (`npm run worker`, see docker-compose.yml).

# ── Build: runs on the CI runner's native arch, so `next build` is not emulated.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && rm -rf .next/cache

# ── Runtime: production dependencies installed for the target arch (arm64 on Oracle Ampere).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/.next ./.next
COPY next.config.ts tsconfig.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
