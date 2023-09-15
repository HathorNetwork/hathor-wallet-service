import { WebSocket } from 'ws';
import { Event } from '../machines/types';

const WS_URL = 'wss://wallet-service-test.private-nodes.hathor.network/v1a/event_ws';
// const WS_URL = 'ws://localhost:8083/v1a/event_ws';

// @ts-ignore
export default (callback, receive) => {
  let socket: WebSocket;

  receive((event: Event) => {
    if (event.type !== 'WEBSOCKET_SEND_EVENT') {
      console.warn('Message that is not websocket_send_event reached the websocket actor');

      return;
    }

    if (!socket) {
      console.error('Received event but no socket yet');
    }

    socket.send(event.event.message);
  });

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    callback({
      type: 'WEBSOCKET_EVENT',
      event: {
        type: 'CONNECTED',
      },
    });
  };

  socket.onmessage = (socketEvent) => {
    const event = JSON.parse(socketEvent.data.toString());
    console.log(`Received ${event.event.type} from socket.`);

    callback({
      type: 'FULLNODE_EVENT',
      event,
    });
  };

  socket.onclose = () => {
    callback({
      type: 'WEBSOCKET_EVENT',
      event: {
        type: 'DISCONNECTED',
      },
    });
  };

  // Delete websocket connection here:
  return () => {
    if (socket) {
      socket.close();
    }
  };
};
