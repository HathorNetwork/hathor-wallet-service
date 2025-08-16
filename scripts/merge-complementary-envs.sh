#!/bin/sh

set -e

# Only run if FETCH_SHARED_ENV environment variable is set
if [ -z "$FETCH_SHARED_ENV" ]; then
    echo "FETCH_SHARED_ENV not set, skipping merge of complementary environment variables"
    exit 0
fi

echo "FETCH_SHARED_ENV is set, merging complementary environment variables..."

# Check if the shared .env file exists
if [ ! -f "/shared/.env" ]; then
    echo "Warning: /shared/.env file not found, skipping merge"
    exit 0
fi

# Copy the shared .env file to the local root
echo "Copying /shared/.env to local .env file..."
cp /shared/.env .env

# Export each environment variable from the .env file
echo "Exporting environment variables from .env file..."
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
done < .env

echo "Successfully merged and exported complementary environment variables"
