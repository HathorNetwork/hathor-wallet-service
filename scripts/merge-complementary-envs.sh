#!/bin/sh

# Copyright 2025 Hathor Labs
# This software is provided ‘as-is’, without any express or implied
# warranty. In no event will the authors be held liable for any damages
# arising from the use of this software.
# This software cannot be redistributed unless explicitly agreed in writing with the authors.

# =========================================================================
# This script is meant to be run inside the Wallet Service Daemon container: if the environment variable
# FETCH_FULLNODE_IDS is set, it will fetch the dynamically created fullnode ids and add them to the current
# environment variables. This way, the Wallet Service can connect to the fullnode.
#
# Outside of this containerized scope, it's not advisable to dynamically obtain the fullnode ids, as it
# serves as an additional security layer. The recommended approach is to set the fullnode ids as
# environment variables directly, ensuring that only the trusted fullnode is used.

set -e

# Skip the dynamic fetching if the specific environment variable is not set
if [ -z "$FETCH_FULLNODE_IDS" ]; then
    echo "FETCH_FULLNODE_IDS not set, skipping merge of complementary environment variables"
    # No fetching needed, run the main script for the Wallet Service Daemon
    node dist/index.js
    exit 0
fi

echo "FETCH_FULLNODE_IDS is set, merging complementary environment variables..."
node fetch-fullnode-ids.js

# Check if the identifiers env file exists
FULLNODE_IDENTIFIER_ENVS_FILE="${FULLNODE_IDENTIFIER_ENVS_FILE:-.identifiers.env}"
if [ ! -f "$FULLNODE_IDENTIFIER_ENVS_FILE" ]; then
    echo "Warning: $FULLNODE_IDENTIFIER_ENVS_FILE file not found, skipping merge"
    # No fetching needed, run the main script for the Wallet Service Daemon
    node dist/index.js
    exit 0
fi

# Export each environment variable from the identifiers env file
echo "Exporting environment variables from $FULLNODE_IDENTIFIER_ENVS_FILE file..."

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
