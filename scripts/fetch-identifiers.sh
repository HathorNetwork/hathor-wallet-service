set -e
set -o pipefail

# This script is meant to be executed when the Wallet Service Daemon is started within a dynamic private network,
# most likely in a Docker container together with a new fullnode in a pristine blockchain.

# In that scenario, it's not reasonable to know beforehand the Peer ID and Stream ID of the fullnode,
# so this script will fetch them from the fullnode's WebSocket endpoint and store them in
# the .identifiers.env file, which is then used by the Wallet Service Daemon.
echo "Fetching Peer ID and Stream ID from the current fullnode URL...";

# Ensure the required tools are installed
apk update && apk add jq websocat

# Fetch the Peer ID and Stream ID from the fullnode's WebSocket endpoint
IDS="$(echo '{"type":"START_STREAM","window_size":1}' | websocat -1 "ws://fullnode:8080/v1a/event_ws" | jq -r '.peer_id, .stream_id' 2>/dev/null)";
FULLNODE_PEER_ID="$(printf "%s\n" "$IDS" | sed -n '1p')";
STREAM_ID="$(printf "%s\n" "$IDS" | sed -n '2p')";

# Write the identifiers to the .identifiers.env file
printf "STREAM_ID=%s\nFULLNODE_PEER_ID=%s\n" "$STREAM_ID" "$FULLNODE_PEER_ID" > .identifiers.env;
