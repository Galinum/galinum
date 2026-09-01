FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @galinum/core build && pnpm --filter @galinum/server build

ENV PORT=3000
EXPOSE 3000
CMD ["node", "packages/server/dist/cli.js"]
