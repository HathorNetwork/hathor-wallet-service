# Copyright 2025 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# This Dockerfile is used to build and run the database migration container.
FROM node:22-alpine AS builder

WORKDIR /app
RUN pwd

RUN apk update && apk add python3 g++ make py3-setuptools

# Copy the entire project to access all necessary files
COPY . .

# corepack will use the version of yarn specified in package.json
RUN corepack enable

# This will install dependencies for all packages, except for the lambdas since
# they are ignored in .dockerignore
RUN yarn install

# When calling this container, we suggest the following configurations
#      args:
#        DB_ENDPOINT: "mysql-endpoint"
#        DB_NAME: "wallet_service_db_name"
#        DB_USER: "wallet_service_user_name"
#        DB_PASS: "wallet_service_user_password"
#        DB_PORT: 3306
#    restart: "no"  # Critical: don't restart migration service
#    command: ["/bin/sh", "migrate.sh"]
#    depends_on:
#      mysql:
#        condition: service_healthy
