# Copyright 2025 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# =========================================================================
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

# Copy only the necessary files for the migration
COPY ./db ./db
COPY ./db/migrations ./migrations

# This will install only the exact versions of sequelize, sequelize-cli and mysql2
# that are already in use in the project, avoiding any unwanted upgrades.
# It will also install the dotenv package, but it's not as critical and we can use the latest version.
#
# Note that this migrator container does not need to have all the dependencies of the main project,
# as it will only be used to run the migration scripts. For this, a new package.json is created
# with only the necessary dependencies, reducing image size.

ARG SEQUELIZE_VERSION
ARG SEQUELIZE_CLI_VERSION
ARG MYSQL2_VERSION
RUN test -n "$SEQUELIZE_VERSION" \
  && test -n "$SEQUELIZE_CLI_VERSION" \
  || (echo "Both SEQUELIZE_VERSION and SEQUELIZE_CLI_VERSION must be set" && exit 1)
# Avoids potential conflicts with pre-installed v1.x versions of yarn
RUN npm uninstall -g yarn
RUN corepack enable
RUN echo '{"name": "migrator", "private": true}' > package.json
RUN yarn add sequelize@"$SEQUELIZE_VERSION" sequelize-cli@"$SEQUELIZE_CLI_VERSION" mysql2@"$MYSQL2_VERSION" dotenv

# Run the migration scripts
RUN cp /app/db/migration-entrypoint.sh /app;
ENTRYPOINT ["/bin/sh", "/app/migration-entrypoint.sh"]
