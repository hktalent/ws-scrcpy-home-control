# Dockerfile for ws-scrcpy-home-control
# Based on Node.js + OpenJDK + Android Platform Tools (ADB)
FROM node:20-bookworm-slim

LABEL maintainer="ws-scrcpy-home-control"
LABEL description="WebSocket-based Android scrcpy home control server"

# Install required system packages: ADB platform tools, openjdk (for scrcpy-server.jar)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        wget \
        ca-certificates \
        iproute2 \
        net-tools \
        curl \
        procps \
        unzip && \
    rm -rf /var/lib/apt/lists/*

# Download Android Platform Tools (ADB)
RUN cd /opt && \
    wget -q https://dl.google.com/android/repository/platform-tools-latest-linux.zip && \
    unzip -q platform-tools-latest-linux.zip && \
    rm platform-tools-latest-linux.zip && \
    chmod +x /opt/platform-tools/adb

# Add platform-tools to PATH
ENV PATH="/opt/platform-tools:${PATH}"
ENV ADB_SERVER_SOCKET=tcp:0.0.0.0:5037

# Create app directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./

# Install npm dependencies
RUN npm install --omit=dev

# Copy application code
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY config ./config

# Environment variables (can be overridden)
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/app/config/default.json

# Expose HTTP port
EXPOSE 8080 5037

# Copy startup script
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
