FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/dhis2-client/package.json packages/dhis2-client/package.json


RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages

RUN pnpm --filter @dhis-sync/contracts build
RUN pnpm --filter @dhis-sync/dhis2-client build
RUN pnpm --filter @dhis-sync/api build

EXPOSE 4000

CMD ["node", "apps/api/dist/main.js"]




