#!/bin/sh
set -e

# Fetching identifiers from the Fullnode, so that the pristine Wallet Service
# can properly connect to the also pristine Fullnode that was just created
echo "Fetching identifiers from Fullnode..."
node scripts/fetch-fullnode-ids.js > .ids.env
ls -la .ids.env
cat .ids.env

# Copy to shared volume (this works at runtime when volume is mounted)
cp .ids.env /shared/.env
echo "Copied identifiers to shared volume"

# Run the actual migration script.
# Note that this is supposed to run from the root of the repository, inside a container
./scripts/migrate.sh

# Run the migration command
exec "$@"
