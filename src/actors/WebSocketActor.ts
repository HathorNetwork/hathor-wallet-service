import { WebSocket } from 'ws';
import { Event } from '../machines/types';
import logger from '../logger';

const WS_URL = process.env.WS_URL;
if (!WS_URL) {
  logger.error('WS_URL is not defined.');
  process.exit(1);
}

export default (callback: any, receive: any) => {
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
    logger.debug(`Received ${event.event.type}: ${event.event.id} from socket.`);

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
