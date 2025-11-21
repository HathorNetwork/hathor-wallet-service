#!/bin/sh
set -e

# Run the migration script.
# Note that this is supposed to run from the root of the repository, inside a container
corepack enable
yarn sequelize db:migrate --config db/config.js

# Run the command passed to the entrypoint (if any).
exec "$@"
