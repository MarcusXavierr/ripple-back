FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY tsconfig.json ./

ENV PORT=9999
EXPOSE 9999

CMD ["bun", "run", "src/index.ts"]
