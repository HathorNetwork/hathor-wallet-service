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

# corepack will use the version of yarn specified in package.json
RUN corepack enable

# This will install dependencies for all packages, except for the lambdas since
# they are ignored in .dockerignore
RUN yarn install

RUN yarn workspace sync-daemon run build

# This will remove all dev dependencies and install production deps only
RUN yarn workspaces focus -A --production

# Run phase
FROM node:20-alpine AS runner

WORKDIR /app

# Copy only the necessary files from the build phase
COPY --from=builder /app .

WORKDIR /app/packages/daemon/

CMD ["node", "dist/index.js"]
