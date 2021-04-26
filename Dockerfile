# Copyright 2020 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

FROM node:14 AS builder

COPY package.json /app/
RUN cd /app && npm install --global --unsafe-perm tsdx@0.14.1
RUN npm install --production

COPY . /app/

RUN cd /app && npm run build

FROM node:14-alpine3.13 AS builder

COPY --from=builder /app/dist/ /app/
COPY --from=builder /app/node_modules /app/node_modules

CMD node /app/index.js
