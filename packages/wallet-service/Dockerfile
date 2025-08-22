# Multi-stage Dockerfile for wallet-service with serverless-offline
# Optimized for development, testing, and validation

# Build stage
FROM node:22-alpine

# Install system dependencies needed for native modules
RUN apk add --no-cache \
    python3 \
    g++ \
    make \
    py3-setuptools \
    git

WORKDIR /app

# Copy root package files
COPY . .

# Enable corepack for yarn
RUN corepack enable
RUN yarn install

WORKDIR /app/packages/wallet-service
# RUN yarn install

# Expose serverless-offline default port
EXPOSE 3000
# Expose websocket port
EXPOSE 3001

RUN chmod +x ./entrypoint.sh

# Run serverless offline
ENTRYPOINT ["./entrypoint.sh"]
