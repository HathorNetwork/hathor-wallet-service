# Copyright 2024 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# This Dockerfile is used to build and run the Wallet Service Daemon container.
# It requires:
# - A MySQL instance, properly migrated ( see /db/Dockerfile )
# - A Fullnode instance
# - A Redis instance
#
# See the HathorNetwork / Wallet Lib repository for a live example on how to use this Dockerfile, but in short:
#  ws-daemon:
#    build:
#      context: '{repository_root}/'
#      dockerfile: 'packages/daemon/Dockerfile'
#    depends_on:
#      ws-migrator:
#        condition: service_completed_successfully
#      fullnode:
#        condition: service_healthy
#      mysql:
#        condition: service_healthy
#    environment:
#      ...
#    ports:
#      - "8081:8081"
#      - "8082:8082"
#    networks:
#      - hathor-privnet

# Build phase
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk update && apk add python3 g++ make py3-setuptools

COPY . .

# corepack will use the version of yarn specified in package.json
RUN corepack enable

# This will install dependencies for all packages, except for the lambdas since
# they are ignored in .dockerignore
RUN yarn install

RUN yarn workspace sync-daemon run build

# This will remove all dev dependencies and install production deps only
RUN yarn workspaces focus -A --production

# Run phase
FROM node:22-alpine AS runner

WORKDIR /app

# Copy only the necessary files from the build phase
COPY --from=builder /app .
RUN ls

WORKDIR /app/packages/daemon/
RUN echo "Running in /app/packages/daemon/"
RUN ls

# The script should already be available from the builder stage copy
# Just make it executable and verify it exists
RUN ls -la /app/scripts/
RUN cp /app/scripts/fetch-fullnode-ids.js ./fetch-fullnode-ids.js
RUN cp /app/scripts/merge-complementary-envs.sh ./merge-complementary-envs.sh
RUN chmod +x ./merge-complementary-envs.sh

# The daemon could need complementary environment variables dynamically.
# The entrypoint script manages this before actually running the daemon.
ENTRYPOINT ["./merge-complementary-envs.sh"]
