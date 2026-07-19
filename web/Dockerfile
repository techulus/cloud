FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable pnpm && corepack prepare pnpm@11 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS builder
WORKDIR /app
ARG APP_VERSION=dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV BETTER_AUTH_SECRET=build-secret
ENV BETTER_AUTH_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
RUN npx next build

FROM node:24-slim AS drizzle
WORKDIR /drizzle
RUN apt-get update \
	&& apt-get install -y --no-install-recommends patch \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install drizzle-kit@0.31.10 drizzle-orm@0.45.2
COPY patches/drizzle-kit@0.31.10.patch /tmp/drizzle-kit.patch
RUN patch --directory=node_modules/drizzle-kit --strip=1 < /tmp/drizzle-kit.patch

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=drizzle /drizzle/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "server.js"]
