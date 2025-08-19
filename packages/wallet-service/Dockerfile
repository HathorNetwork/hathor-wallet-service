# Multi-stage Dockerfile for wallet-service with serverless-offline
# Optimized for development, testing, and validation

# Build stage
FROM node:22-alpine AS builder

# Install system dependencies needed for native modules
RUN apk add --no-cache \
    python3 \
    g++ \
    make \
    py3-setuptools \
    git

WORKDIR /app

# Copy package files for better caching
COPY package.json yarn.lock ./
COPY packages/common/package.json ./packages/common/
COPY packages/wallet-service/package.json ./packages/wallet-service/

# Enable corepack for yarn
RUN corepack enable

# Install dependencies (including dev dependencies for building)
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build the common package first (dependency)
RUN yarn workspace @wallet-service/common run build || echo "No build script for common package"

# Build the wallet-service package
RUN yarn workspace wallet-service run check-types

# Development stage
FROM node:22-alpine AS development

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    g++ \
    make \
    py3-setuptools \
    git \
    curl \
    bash

WORKDIR /app

# Enable corepack
RUN corepack enable

# Copy built application from builder stage
COPY --from=builder /app .

# Set proper permissions
RUN chmod +x /app/packages/wallet-service/node_modules/.bin/* || true

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S wallet-service -u 1001 -G nodejs

# Change ownership of the app directory
RUN chown -R wallet-service:nodejs /app

# Switch to non-root user
USER wallet-service

# Set working directory to wallet-service package
WORKDIR /app/packages/wallet-service

# Expose serverless-offline default port
EXPOSE 3000

# Health check for container readiness
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Default command to run serverless offline
CMD ["yarn", "serverless", "offline", "start", "--host", "0.0.0.0", "--httpPort", "3000"]

# Production-like stage (for testing production builds)
FROM node:22-alpine AS production

RUN apk add --no-cache \
    python3 \
    g++ \
    make \
    py3-setuptools

WORKDIR /app

# Enable corepack
RUN corepack enable

# Copy package files
COPY package.json yarn.lock ./
COPY packages/common/package.json ./packages/common/
COPY packages/wallet-service/package.json ./packages/wallet-service/

# Install only production dependencies
RUN yarn install --frozen-lockfile --production

# Copy source and built files
COPY . .
COPY --from=builder /app/packages/common/dist ./packages/common/dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S wallet-service -u 1001 -G nodejs && \
    chown -R wallet-service:nodejs /app

USER wallet-service
WORKDIR /app/packages/wallet-service

EXPOSE 3000

CMD ["yarn", "serverless", "offline", "start", "--host", "0.0.0.0", "--httpPort", "3000"]
