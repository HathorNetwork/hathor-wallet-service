import { WebSocket } from 'ws';
import { SCENARIOS } from './config';
import * as config from './config';

const attemptConnection = async (port: number, maxAttempts: number, interval: number): Promise<void> => {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      await new Promise((resolve, reject) => {
        // Create a new WebSocket connection
        const client = new WebSocket(`ws://127.0.0.1:${port}/v1a/event_ws`);

        client.on('open', function open() {
          // Start the stream
          client.send(JSON.stringify({
            type: 'START_STREAM',
            window_size: 1,
          }));
        });

        client.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.event.type === 'LOAD_STARTED') {
            client.close();
            resolve(null);
            return;
          }

          throw new Error('Unexpected response from websocket');
        });

        // Event listener for handling errors
        client.on('error', (err) => reject(err));
      });
      return;
    } catch (err: any) {
      console.error('Failed to connect to websocket:', err.message);
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Retrying connection... Attempt ${attempts} of ${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, interval));
      } else {
        console.error('Maximum connection attempts reached. Exiting.');
        throw err;
      }
    }
  }
};

const main = async () => {
  // We should test all scenarios
  for (let i = 0; i < SCENARIOS.length; i++) {
    try {
      // @ts-ignore
      const port = config[`${SCENARIOS[i]}_PORT`];
      // Attempt to connect
      await attemptConnection(port, 30, 10000);
    } catch (err) {
      console.log(err);
      process.exit(1);
    }
  }
}

main();
