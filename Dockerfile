# Build stage: install all deps and compile server + client
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build

# Runtime stage: production deps + compiled output only
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/index.html ./client/index.html
COPY --from=build /app/client/dist ./client/dist

USER node
EXPOSE 3000 9100
CMD ["node", "server/dist/server/src/index.js"]
