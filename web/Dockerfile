# Web (Next.js 15) — multi-stage build, standalone runtime.
FROM node:20-slim AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
# NEXT_PUBLIC_* are inlined at build time → must be present when building. Pages are
# force-dynamic so the DB is never queried at build, but DATABASE_URL is provided so the
# pg client module can construct without throwing during the build.
ARG NEXT_PUBLIC_BOT_USERNAME
ARG DATABASE_URL
ENV NEXT_PUBLIC_BOT_USERNAME=$NEXT_PUBLIC_BOT_USERNAME \
    DATABASE_URL=$DATABASE_URL \
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
# `output: standalone` does NOT bundle public/ — copy it so /logo.png, /sw.js,
# and other static assets are served (otherwise they 404 in production).
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
