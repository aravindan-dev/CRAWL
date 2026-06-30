# Next.js dashboard. Build context = repo root.
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

COPY . .
RUN pnpm install --no-frozen-lockfile

# Build the Next app. NEXT_PUBLIC_API_URL is baked at build time; override at
# runtime via the same env if your API is not on localhost:4000.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @clg/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@clg/web", "start"]
