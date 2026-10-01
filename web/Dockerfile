# Build-only image (see README "web/Dockerfile contract"): compose runs
#   sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"
# against this image, so the final stage only needs /app/dist plus sh/rm/cp.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Baked into the bundle by vite.config.ts (`__BUILD__`), for the footer's version line.
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
RUN npm run build

FROM alpine:3.20
COPY --from=build /app/dist /app/dist
CMD ["sh", "-c", "true"]
