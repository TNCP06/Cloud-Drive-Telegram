# Web (Next.js 15) — multi-stage build, standalone runtime.
FROM node:20-slim AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
# NEXT_PUBLIC_* are inlined at build time → must be present when building.
ARG NEXT_PUBLIC_BOT_USERNAME
ARG TURSO_DATABASE_URL
ARG TURSO_AUTH_TOKEN
ENV NEXT_PUBLIC_BOT_USERNAME=$NEXT_PUBLIC_BOT_USERNAME \
    TURSO_DATABASE_URL=$TURSO_DATABASE_URL \
    TURSO_AUTH_TOKEN=$TURSO_AUTH_TOKEN \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
