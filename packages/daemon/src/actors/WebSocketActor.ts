/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebSocket } from 'ws';
import { Event, FullNodeEventSchema } from '../types';
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

  const socket: WebSocket = new WebSocket(getFullnodeWsUrl());
  let pingTimeout: NodeJS.Timeout = createPingTimeout();
  let pingTimer: NodeJS.Timer;
  // Set when the daemon closes the socket itself (the actor was stopped), so the
  // close log tells a local close apart from one done by the other side.
  let closedByDaemon = false;

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
    const parseResult = FullNodeEventSchema.safeParse(
      bigIntUtils.JSONBigInt.parse(socketEvent.data.toString())
    );
    if (!parseResult.success) {
      logger.error(`Could not parse event: ${socketEvent.data.toString()}`);
      throw new Error(parseResult.error.message);
    }
    const event = parseResult.data;
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

  socket.onclose = (closeEvent) => {
    clearTimeout(pingTimeout);
    clearInterval(pingTimer);
    // The close code tells who closed the connection: 1006 means it dropped without a
    // close frame (network path or load balancer), 1000/1001 a deliberate close.
    const reason = closeEvent.reason ? `, reason: ${closeEvent.reason}` : '';
    const closedBy = closedByDaemon ? ', closed by daemon' : '';
    logger.info(`WebSocket closed with code ${closeEvent.code}${reason}${closedBy}`);
    callback({
      type: 'WEBSOCKET_EVENT',
      event: {
        type: 'DISCONNECTED',
      },
    });
  };

  // Delete websocket connection here:
  return () => {
    closedByDaemon = true;
    clearTimeout(pingTimeout);
    clearInterval(pingTimer);
    if (socket) {
      socket.close();
    }
  };
};
