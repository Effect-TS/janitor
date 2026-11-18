# The voice transport probe; see probe.ts and ../README.md.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /probe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY probe.ts stun.ts filters.ts codes.ts ./
USER node
EXPOSE 8080
ENTRYPOINT ["node", "probe.ts"]
