/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebSocket } from 'ws';
import { Event } from '../types';
import { get } from 'lodash';
import logger from '../logger';
import { getFullnodeWsUrl } from '../utils';

export default (callback: any, receive: any) => {
  const wsUrl = getFullnodeWsUrl();

  // @ts-ignore: We already check for missing envs in startup
  const socket: WebSocket = new WebSocket(wsUrl);

  receive((event: Event) => {
    if (event.type !== 'WEBSOCKET_SEND_EVENT') {
      logger.warn('Message that is not websocket_send_event reached the websocket actor');

      return;
    }

    if (!socket) {
      logger.error('Received event but no socket yet');

      return;
    }

    const payload = JSON.stringify(event.event);

    logger.debug('Sending:')
    logger.debug(payload);
    socket.send(payload);
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
    const type = get(event, 'event.type');

    logger.debug(`Received ${type}: ${get(event, 'event.id')} from socket.`, event);

    if (!type) {
      logger.error(JSON.stringify(event));
      throw new Error('Received an event with no defined type');
    }

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
