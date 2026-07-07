# Build stage
FROM node:22-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Prune dev dependencies
RUN pnpm prune --prod

# Production stage
FROM node:22-alpine

WORKDIR /app

# yt-dlp for Auto Stamp YouTube extraction (Alpine package; brings python3).
# The standalone yt-dlp Linux binary is glibc-only and does NOT run on musl.
RUN apk add --no-cache yt-dlp

# Copy production node_modules and built files
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

EXPOSE 3000

CMD ["node", "dist/server.js"]
