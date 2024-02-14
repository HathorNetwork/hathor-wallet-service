# Copyright 2020 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# Build phase
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk update && apk add python3 g++ make

COPY package.json ./

RUN which python

RUN yarn set version 3.4.1

RUN yarn install

COPY . ./

RUN ls -la /app

RUN yarn run build


# Production phase
FROM node:20-alpine

WORKDIR /app

RUN apk update && apk add python3 g++ make

COPY --from=builder /app/dist/ ./
COPY --from=builder /app/package.json ./

RUN yarn install --production --frozen-lockfile

RUN apk del python3 g++ make

CMD ["node", "index.js"]
