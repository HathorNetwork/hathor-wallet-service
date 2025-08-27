#!/bin/sh
set -e

# Run the migration script.
# Note that this is supposed to run from the root of the repository, inside a container
./scripts/migrate.sh

# Run the command passed to the entrypoint (if any).
exec "$@"
