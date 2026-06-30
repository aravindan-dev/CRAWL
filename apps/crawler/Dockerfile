# Crawler/parse worker. Uses the official Playwright image so Chromium + all
# system dependencies are preinstalled. Build context = repo root.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS base
WORKDIR /app
RUN corepack enable

COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @clg/database generate

ENV NODE_ENV=production
# Browsers are already installed in the base image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
CMD ["pnpm", "--filter", "@clg/crawler", "start"]
