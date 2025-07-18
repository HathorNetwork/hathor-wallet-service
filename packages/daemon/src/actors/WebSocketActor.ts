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
import { bigIntUtils } from '@hathor/wallet-lib';

const PING_TIMEOUT = 30000; // 30s timeout
const PING_INTERVAL = 5000; // Will ping every 5s

export default (callback: any, receive: any) => {
  const createPingTimeout = (): NodeJS.Timeout => setTimeout(() => {
    socket.terminate();
  }, PING_TIMEOUT);
  const createPingTimer = (): NodeJS.Timer => setInterval(() => {
    logger.debug('Sending ping to server');
    socket.ping();
  }, PING_INTERVAL);

  // @ts-ignore: We already check for missing envs in startup
  const socket: WebSocket = new WebSocket(getFullnodeWsUrl());
  let pingTimeout: NodeJS.Timeout = createPingTimeout();
  let pingTimer: NodeJS.Timer;

  const heartbeat = () => {
    logger.debug('Pong received from server');
    clearTimeout(pingTimeout);
    pingTimeout = createPingTimeout();
  };

  receive((event: Event) => {
    if (event.type !== 'WEBSOCKET_SEND_EVENT') {
      logger.warn('Message that is not websocket_send_event reached the websocket actor');

      return;
    }

    if (!socket) {
      logger.error('Received event but no socket yet');

      return;
    }

    const payload = bigIntUtils.JSONBigInt.stringify(event.event);

    logger.debug('Sending:')
    logger.debug(payload);
    socket.send(payload);
  });

  socket.on('pong', heartbeat);

  socket.onopen = () => {
    // Start pinging
    pingTimer = createPingTimer();
    callback({
      type: 'WEBSOCKET_EVENT',
      event: {
        type: 'CONNECTED',
      },
    });
  };

  socket.onmessage = (socketEvent) => {
    const event = bigIntUtils.JSONBigInt.parse(socketEvent.data.toString());
    const type = get(event, 'event.type');

    logger.debug(`Received ${type}: ${get(event, 'event.id')} from socket.`, event);

    if (!type) {
      logger.error(bigIntUtils.JSONBigInt.stringify(event));
      throw new Error('Received an event with no defined type');
    }

    callback({
      type: 'FULLNODE_EVENT',
      event,
    });
  };

  socket.onerror = (e) => {
    logger.error('Socket erroed');
    logger.error(e);
  };

  socket.onclose = () => {
    clearTimeout(pingTimeout);
    clearInterval(pingTimer);
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
