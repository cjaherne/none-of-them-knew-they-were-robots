FROM node:20-bookworm-slim AS builder

WORKDIR /build
COPY package.json tsconfig.json ./
COPY src/ src/
RUN npm install && npm run build

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Cursor CLI headless
# The actual install command depends on the Cursor CLI distribution method.
# This uses the documented install approach; update the URL if needed.
RUN curl -fsSL https://www.cursor.com/api/download?platform=linux-x64-cli -o /tmp/cursor-cli.tar.gz \
    && tar -xzf /tmp/cursor-cli.tar.gz -C /usr/local/bin \
    && rm /tmp/cursor-cli.tar.gz \
    && chmod +x /usr/local/bin/cursor-agent \
    || echo "WARN: Cursor CLI install skipped -- update URL for production builds"

WORKDIR /app

COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/node_modules/ node_modules/
COPY package.json ./

RUN mkdir -p /workspace

ENV NODE_ENV=production

USER node

CMD ["node", "dist/main.js"]
