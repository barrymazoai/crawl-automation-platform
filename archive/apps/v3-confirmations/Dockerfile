FROM node:22.17.0-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080 APPROVAL_DB=/data/approvals.sqlite
EXPOSE 8080
CMD ["node", "src/server.mjs"]
