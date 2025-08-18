#!/bin/sh

set -e

# Only run if FETCH_SHARED_ENV environment variable is set
if [ -z "$FETCH_SHARED_ENV" ]; then
    echo "FETCH_SHARED_ENV not set, skipping merge of complementary environment variables"
    # Finally, run the main script for the Wallet Service Daemon
    node dist/index.js
    exit 0
fi

echo "FETCH_SHARED_ENV is set, merging complementary environment variables..."
node fetch-fullnode-ids.js

# Check if the shared .identifiers.env file exists
if [ ! -f ".identifiers.env" ]; then
    echo "Warning: .identifiers.env file not found, skipping merge"
    exit 0
fi

# Export each environment variable from the .identifiers.env file
echo "Exporting environment variables from .identifiers.env file..."

echo "Here is the file contents:"
cat .identifiers.env
echo "Now the next steps:"

# Read the file line by line
while IFS='=' read -r key value; do
    # Skip empty lines and comments
    if [ -z "$key" ] || echo "$key" | grep -q '^[[:space:]]*#'; then
        continue
    fi

    # Remove any leading/trailing whitespace (using parameter expansion instead of xargs)
    key=$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    # Skip if key is empty after trimming
    if [ -z "$key" ]; then
        continue
    fi

    # Export the variable
    export "$key=$value"
    echo "Exported: $key=$value"
done < .identifiers.env

echo "Successfully merged and exported complementary environment variables"

# Finally, run the main script for the Wallet Service Daemon
node dist/index.js
