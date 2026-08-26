FROM node:22.17.0-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY crawl-products ./crawl-products
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.17.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/backend ./apps/backend
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
EXPOSE 8080
CMD ["node", "apps/backend/dist/index.js"]
