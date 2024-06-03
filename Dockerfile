# Copyright 2024 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.


# Build phase
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk update && apk add python3 g++ make py3-setuptools

COPY . .

RUN corepack enable

# Use the last stable berry version:
RUN yarn set version 4.1.0

# This will install dependencies for the sync-daemon, devDependencies included:
RUN yarn workspaces focus sync-daemon

RUN yarn workspace sync-daemon build

# This will remove all dependencies and install production deps only:
RUN yarn workspaces focus sync-daemon --production

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/packages/daemon/dist .
COPY --from=builder /app/packages/daemon/node_modules ./node_modules

CMD ["node", "index.js"]
