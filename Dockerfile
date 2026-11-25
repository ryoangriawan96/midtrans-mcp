# midtrans-mcp — container image for MCP directory checks (Glama/Smithery)
# and for anyone who prefers running the server in Docker.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The Server Key is provided at runtime:  docker run -e MIDTRANS_SERVER_KEY=... midtrans-mcp
ENTRYPOINT ["node", "dist/index.js"]
