# Multi-stage build for Translation Diff
# 1. Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build production bundle
RUN npm run build

# 2. Runtime stage: serve static build with nginx
FROM nginx:stable-alpine
LABEL org.opencontainers.image.title="translation-diff" \
      org.opencontainers.image.description="Bidirectional translation diff web UI" \
      org.opencontainers.image.source="https://github.com/franz-rosenzweig/translation-diff" \
      org.opencontainers.image.licenses="MIT"

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html
# Provide a basic security header example (can be extended)
RUN sed -i '/server_name  localhost;/a \\
    add_header X-Content-Type-Options "nosniff" always;\n    add_header X-Frame-Options "SAMEORIGIN" always;\n    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n    add_header Permissions-Policy "geolocation=()";\n' /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# The app is fully static; no CMD override needed (nginx default)
