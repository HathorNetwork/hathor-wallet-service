/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebSocket } from 'ws';
import { Event } from '../machines/types';
// @ts-ignore
import { get } from 'lodash';
import logger from '../logger';

const WS_URL = process.env.WS_URL;
if (!WS_URL) {
  logger.error('WS_URL is not defined.');
  process.exit(1);
}

export default (callback: any, receive: any) => {
  const socket: WebSocket = new WebSocket(WS_URL);

  receive((event: Event) => {
    if (event.type !== 'WEBSOCKET_SEND_EVENT') {
      logger.warn('Message that is not websocket_send_event reached the websocket actor');

      return;
    }

    if (!socket) {
      logger.error('Received event but no socket yet');
    }

    socket.send(event.event.message);
  });

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
    logger.debug(`Received ${get(event, 'event.type')}: ${get(event, 'event.id')} from socket.`, event);

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
