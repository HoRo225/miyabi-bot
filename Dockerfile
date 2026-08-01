FROM node:24-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src

FROM deps AS test
RUN npm test

FROM test AS build
RUN rm -rf dist && npm run build:prod

FROM node:24-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/HoRo225/miyabi-bot" org.opencontainers.image.revision="$VCS_REF"
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node ops/backup.mjs ./ops/backup.mjs
USER node
CMD ["node", "dist/index.js"]
