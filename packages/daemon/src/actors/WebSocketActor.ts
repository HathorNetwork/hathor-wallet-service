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
import { addAlert, Severity } from '@wallet-service/common';
import { ZodError } from 'zod';
import { settleWithin } from '../utils/settleWithin';

const PING_TIMEOUT = 30000; // 30s timeout
const PING_INTERVAL = 5000; // Will ping every 5s

/** Most issue paths listed in the schema-failure alert. */
const ALERT_ISSUE_CAP = 10;

/**
 * Longest the daemon waits for the schema-failure alert before failing anyway.
 * The SQS client sets no timeout of its own, and a send that never settles
 * would otherwise keep the process up, reconnecting, instead of exiting.
 */
export const SCHEMA_FAILURE_ALERT_TIMEOUT_MS = 5000;


/**
 * Page on an event the schema rejects. A crash loop on its own only shows in
 * the logs, and the cause is almost always drift between hathor-core's event
 * format and this schema, which needs a deploy to fix. Never throws.
 */
const reportUnparseableEvent = async (raw: unknown, error: ZodError): Promise<void> => {
  try {
    const issues = error.issues
      .slice(0, ALERT_ISSUE_CAP)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    await addAlert(
      'Fullnode event failed schema validation',
      `Event ${String(get(raw, 'event.id'))} (${String(get(raw, 'event.type'))}) does not match `
      + 'the daemon\'s event schema, so sync is stopped on it. It is replayed once the schema '
      + `is fixed. First issue: ${issues[0] ?? 'unknown'}`,
      Severity.CRITICAL,
      {
        event_id: get(raw, 'event.id'),
        event_type: get(raw, 'event.type'),
        tx_id: get(raw, 'event.data.hash'),
        issue_count: error.issues.length,
        issues,
        source: 'daemon',
      },
      logger,
    );
  } catch (e) {
    logger.error('Failed to report an unparseable fullnode event', { error: String(e) });
  }
};

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
  // Set once an event fails to parse. The process exits on it, but only after
  // the alert is sent; until then no later event may reach the machine, or it
  // would be processed past the one that failed.
  let haltedOnUnparseableEvent = false;

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
    if (haltedOnUnparseableEvent) {
      return;
    }
    const raw = bigIntUtils.JSONBigInt.parse(socketEvent.data.toString());
    const parseResult = FullNodeEventSchema.safeParse(raw);
    if (!parseResult.success) {
      haltedOnUnparseableEvent = true;
      logger.error(`Could not parse event: ${socketEvent.data.toString()}`);
      const failure = new Error(parseResult.error.message);
      // Fails the same way as a throw here would, once the alert has gone out
      // or timed out: the rejection is unhandled, which ends the process.
      settleWithin(
        reportUnparseableEvent(raw, parseResult.error),
        SCHEMA_FAILURE_ALERT_TIMEOUT_MS,
      ).then(() => {
        throw failure;
      });
      return;
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
