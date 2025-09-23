// Copyright 2025 Hathor Labs
// This software is provided ‘as-is’, without any express or implied
// warranty. In no event will the authors be held liable for any damages
// arising from the use of this software.
// This software cannot be redistributed unless explicitly agreed in writing with the authors.

const WebSocket = require('ws');
const fs = require('fs');

/**
 * Please note that by default this URL assumes a Docker setup where the fullnode service
 * is accessible via the hostname 'fullnode' on port 8080.
 * It is possible to adjust this using the FULLNODE_WEBSOCKET_BASEURL environment variable.
 * @type {string}
 */
const fullnodeBaseUrl = process.env.FULLNODE_WEBSOCKET_BASEURL || 'fullnode:8080';

/**
 * Output file name.
 * By default, it is 'export-identifiers.sh' in the current directory.
 * This can be changed using the FULLNODE_IDENTIFIER_ENVS_FILE environment variable.
 * @type {string}
 */
const outputFileName = process.env.FULLNODE_IDENTIFIER_ENVS_FILE || 'export-identifiers.sh';

/**
 * Fetches identifiers from the fullnode WebSocket endpoint and writes them to an .env file.
 *
 * This is especially useful when first running a containerized Wallet Service Daemon
 * ( see /packages/daemon/Dockerfile ).
 */
async function fetchFullnodeIds() {
  const wsUrl = `ws://${fullnodeBaseUrl}/v1a/event_ws`;
  const payload = { type: 'START_STREAM', window_size: 1 };

  console.log('Connecting to fullnode WebSocket...');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    // Set a timeout for the connection
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 3000);

    ws.on('open', () => {
      console.log('WebSocket connected, sending payload...');
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data) => {
      clearTimeout(timeout);
      console.log('Received response from fullnode');

      try {
        const response = JSON.parse(data.toString());
        console.log('Parsed response:', JSON.stringify(response, null, 2));

        // Extract the required fields
        const streamId = response.stream_id;
        const fullnodePeerId = response.peer_id;

        if (!streamId || !fullnodePeerId) {
          throw new Error(`Missing required fields in response. stream_id: ${streamId}, peer_id: ${fullnodePeerId}`);
        }

        // Create .env file content
        const envContent = `export STREAM_ID=${streamId}\nexport FULLNODE_PEER_ID=${fullnodePeerId}\n`;

        // Write to output file
        fs.writeFileSync(outputFileName, envContent);
        console.warn(`Written identifiers to ${outputFileName}: ${envContent}`);

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

/*
 * In this script, all console output is directed to stderr except for the final
 * .env content which is printed to stdout. This allows the script to be used
 * in shell scripts that capture the output directly into environment variables.
 */

// Main execution
if (require.main === module) {
  fetchFullnodeIds()
    .then(({ streamId, fullnodePeerId }) => {
      console.log(`Successfully fetched identifiers. Exiting.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to fetch identifiers with error:', error.message);

      // Create empty .env file as fallback
      const fallbackContent = 'STREAM_ID=\nFULLNODE_PEER_ID=\n';
      fs.writeFileSync(outputFileName, fallbackContent);

      console.log(`Created ${outputFileName} with empty values due to error. Exiting.`);
      process.exit(1);
    });
}

module.exports = { fetchFullnodeIds };
