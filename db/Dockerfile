# Copyright 2025 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# This Dockerfile is intended for migrating the database of a dockerized private blockchain
# for the Wallet Service Daemon.
#
# It serves only as a means to run the migration scripts in an isolated environment. The container will run only
# for as long as the migration is running, and then it will exit.
#
# The migration scripts do not cause any impact if it is ran multiple times, so it is safe to run this container
# for each deployment of the Wallet Service Daemon.
#
# Sample usage in a docker-compose.yml:
#  ws-migrator:
#    build:
#      context: '{repository_root}/'
#      dockerfile: 'db/Dockerfile'
#    restart: "no"  # Critical: don't restart migration service
#    depends_on:
#      mysql: # Replace with your actual mysql service name
#        condition: service_healthy
#    environment:
#      DB_ENDPOINT: "mysql"
#      DB_NAME: "wallet_service"
#      DB_USER: "wallet_service_user"
#      DB_PASS: "password"
#      DB_PORT: 3306
#    networks:
#      - hathor-privnet

# This Dockerfile is used to build and run the database migration container.
FROM node:22-alpine

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

# Create the shared directory for volume mounting
RUN mkdir -p /shared

# Create a startup script that handles fetching identifiers and copying to shared volume
RUN cp /app/db/migration-entrypoint.sh /app/migration-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/app/migration-entrypoint.sh"]
