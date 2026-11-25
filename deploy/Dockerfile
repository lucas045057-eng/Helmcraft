FROM node:24-bookworm AS workspace
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@11.17.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/common/package.json packages/common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/hub/package.json packages/hub/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/worker/package.json packages/worker/
COPY packages/mock-cli/package.json packages/mock-cli/

FROM workspace AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages/ packages/
RUN pnpm --filter @agent-hub/hub... --filter @agent-hub/dashboard... -r build

FROM workspace AS dependencies
RUN pnpm --filter @agent-hub/hub... install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/protocol ./packages/protocol
COPY --from=dependencies /app/packages/common ./packages/common
COPY --from=dependencies /app/packages/hub ./packages/hub
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/common/dist ./packages/common/dist
COPY --from=build /app/packages/hub/dist ./packages/hub/dist
COPY --from=build /app/packages/hub/migrations ./packages/hub/migrations
COPY --from=build /app/packages/hub/maintenance ./packages/hub/maintenance
COPY --from=build /app/packages/dashboard/dist/site ./packages/dashboard/dist/site
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","packages/hub/dist/main.js","/app/hub.yaml"]
