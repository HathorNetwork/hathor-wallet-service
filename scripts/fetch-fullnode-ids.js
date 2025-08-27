// Copyright 2025 Hathor Labs
// This software is provided ‘as-is’, without any express or implied
// warranty. In no event will the authors be held liable for any damages
// arising from the use of this software.
// This software cannot be redistributed unless explicitly agreed in writing with the authors.

const WebSocket = require('ws');
const fs = require('fs');

/**
 * Please note that this URL assumes a Docker setup where the fullnode service
 * is accessible via the hostname 'fullnode' on port 8080. Adjust as necessary.
 * @type {string}
 */
const fullnodeBaseUrl = 'fullnode:8080';

/**
 * Output .env file name
 * @type {string}
 */
const outputFileName = '.identifiers.env';

/**
 * Fetches identifiers from the fullnode WebSocket endpoint
 * and writes them to an .env file, then outputs to stdout
 *
 * This is especially useful when first running a containerized Wallet Service Daemon
 * ( see /packages/daemon/Dockerfile ).
 */
async function fetchFullnodeIds() {
  const wsUrl = `ws://${fullnodeBaseUrl}/v1a/event_ws`;
  const payload = { type: 'START_STREAM', window_size: 1 };

  console.error('Connecting to fullnode WebSocket...');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    // Set a timeout for the connection
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 3000);

    ws.on('open', () => {
      console.error('WebSocket connected, sending payload...');
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data) => {
      clearTimeout(timeout);
      console.error('Received response from fullnode');

      try {
        const response = JSON.parse(data.toString());
        console.error('Parsed response:', JSON.stringify(response, null, 2));

        // Extract the required fields
        const streamId = response.stream_id;
        const fullnodePeerId = response.peer_id;

        if (!streamId || !fullnodePeerId) {
          throw new Error(`Missing required fields in response. stream_id: ${streamId}, peer_id: ${fullnodePeerId}`);
        }

        // Create .env file content
        const envContent = `STREAM_ID=${streamId}\nFULLNODE_PEER_ID=${fullnodePeerId}\n`;

        // Write to output file
        fs.writeFileSync(outputFileName, envContent);
        console.error(`Written identifiers to ${outputFileName}`);

        // Output to stdout for shell script consumption
        console.log(envContent);

        ws.close();
        resolve({ streamId, fullnodePeerId });

      } catch (error) {
        ws.close();
        reject(new Error(`Failed to parse response: ${error.message}`));
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.error('WebSocket error:', error.message);
      reject(new Error(`WebSocket connection failed: ${error.message}`));
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000) {
        console.error(`WebSocket closed with code ${code}, reason: ${reason}`);
        reject(new Error(`WebSocket closed unexpectedly: ${code} ${reason}`));
      }
    });
  });
}

// Main execution
if (require.main === module) {
  fetchFullnodeIds()
    .then(({ streamId, fullnodePeerId }) => {
      console.error(`Successfully fetched identifiers:`);
      console.error(`STREAM_ID: ${streamId}`);
      console.error(`FULLNODE_PEER_ID: ${fullnodePeerId}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error:', error.message);

      // Create empty .env file as fallback
      const fallbackContent = 'STREAM_ID=\nFULLNODE_PEER_ID=\n';
      fs.writeFileSync(outputFileName, fallbackContent);
      console.error(`Created ${outputFileName} with empty values due to error`);

      // Still output to stdout for shell script
      console.log(fallbackContent);

      process.exit(1);
    });
}

module.exports = { fetchFullnodeIds };
