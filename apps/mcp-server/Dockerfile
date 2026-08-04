FROM node:22-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/mcp-server/package.json apps/mcp-server/package.json
RUN pnpm install --filter @data-room-cited/mcp-server --frozen-lockfile

COPY apps/mcp-server apps/mcp-server
RUN pnpm --filter @data-room-cited/mcp-server build

EXPOSE 8787
CMD ["pnpm", "--filter", "@data-room-cited/mcp-server", "start"]
