# API service (Fastify, run via tsx). Build context = repo root.
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# Install dependencies for the whole workspace (so workspace packages resolve).
COPY . .
RUN pnpm install --no-frozen-lockfile

# Generate the Prisma client.
RUN pnpm --filter @clg/database generate

ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@clg/api", "start"]
