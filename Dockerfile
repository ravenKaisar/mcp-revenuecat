FROM dhi.io/node:26-debian-dev AS deps

WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm install --frozen-lockfile

FROM dhi.io/node:26-debian-dev AS build

WORKDIR /app

RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

FROM dhi.io/node:26-debian AS runtime

WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
