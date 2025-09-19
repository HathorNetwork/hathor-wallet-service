# Copyright 2025 Hathor Labs
# This software is provided 'as-is', without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# =========================================================================
# This Dockerfile is used to build and run the Wallet Service container.
# It requires:
# - A MySQL instance, properly migrated ( see /db/Dockerfile )
# - A Fullnode instance
# - A started Wallet Service Daemon instance ( see /packages/daemon/Dockerfile )
#
# The expected image size is about 1800MB as of v1.9.0. This is because `serverless` is a development
# dependency and needs to be installed in the final image, reducing the optimization options for
# reducing this size.
#
# To properly connect to a dockerized private network, in the environment variables, you should set `MOCK_AWS=true`
# to avoid trying to connect to external AWS services, except if the container is being run connected to a publicly
# available network.
#
# See the HathorNetwork / Wallet Lib repository for a live example on how to use this Dockerfile, but in short:
#  ws-serverless:
#    image: hathornetwork/hathor-wallet-service-service
#    depends_on:
#      fullnode:
#        condition: service_healthy
#      mysql:
#        condition: service_healthy
#      ws-daemon:
#        condition: service_started
#    environment:
#      IS_OFFLINE: true
#      ENV MOCK_AWS=true # Necessary to avoid trying to connect to external AWS services
#      ...
#    ports:
#      - "3000:3000"
#      - "3001:3001"
#    networks:
#      - hathor-privnet

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

# Expose serverless-offline default port
EXPOSE 3000
# Expose websocket port
EXPOSE 3001

RUN chmod +x ./entrypoint.sh

# Run serverless offline
ENTRYPOINT ["./entrypoint.sh"]
