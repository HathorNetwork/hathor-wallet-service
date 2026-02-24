/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assign, AssignAction, sendTo } from 'xstate';
import { Context, Event, EventTypes, StandardFullNodeEvent } from '../types';
import { get } from 'lodash';
import logger from '../logger';
import { hashTxData } from '../utils';
import { createStartStreamMessage, createSendAckMessage } from '../actors';
import { bigIntUtils } from '@hathor/wallet-lib';

/*
 * This action is used to store the initial event id on the context
 */
export const storeInitialState = assign({
  initialEventId: (_context: Context, event: Event) => {
    // @ts-ignore
    return event.data.lastEventId;
  },
  rewardMinBlocks: (_context: Context, event: Event) => {
    // @ts-ignore
    return event.data.rewardMinBlocks;
  },
});

/*
 * This action stores the metadata change types from metadataDiff into context
 * and sets context.event from the original event.
 */
export const storeMetadataChanges = assign({
  pendingMetadataChanges: (_context: Context, event: Event) => {
    // @ts-ignore
    return event.data.types;
  },
  // @ts-ignore
  event: (_context: Context, event: Event) => {
    // @ts-ignore
    return event.data.originalEvent.event;
  },
});

/*
 * This action removes the first element from pendingMetadataChanges.
 */
export const shiftMetadataChange = assign({
  pendingMetadataChanges: (context: Context) => {
    const changes = context.pendingMetadataChanges ?? [];
    return changes.slice(1);
  },
});

/*
 * This action is used to increase the retry count on the context
 */
export const increaseRetry = assign({
  retryAttempt: (context: Context) => context.retryAttempt + 1,
});

/*
 * This is a helper to get the socket ref from the context and throw if it's not
 * found.
 */
export const getSocketRefFromContext = (context: Context) => {
  if (!context.socket) {
    throw new Error('No socket in context');
  }

  return context.socket;
};

/*
 * This is a helper to get the healthcheck ref from the context and throw if it's not
 * found.
 */
export const getHealthcheckRefFromContext = (context: Context) => {
  if (!context.healthcheck) {
    throw new Error('No healthcheck in context');
  }

  return context.healthcheck;
};

/*
 * This action sends an event to the socket actor
 */
export const startStream = sendTo(
  getSocketRefFromContext,
  (context: Context, _event: Event) => {
    const lastAckEventId = get(context, 'event.event.id', context.initialEventId);

    return {
      type: 'WEBSOCKET_SEND_EVENT',
      // @ts-ignore
      event: createStartStreamMessage(lastAckEventId),
    };
  });

/*
 * This action clears the socket ref from context
 */
export const clearSocket = assign({
  socket: null,
});

/*
 * This action stores the event on the machine's context. It also asserts that
 * the event being saved is higher than the last one and fails if it's not.
 */
export const storeEvent: AssignAction<Context, Event> = assign({
  event: (context: Context, event: Event) => {
    if (event.type !== 'FULLNODE_EVENT') {
      return context.event;
    }

    const eventId = get(event, 'event.event.id', -1);
    const contextEventId = get(context, 'event.id', -1);

    if (eventId === -1) {
      return;
    }

    if (context.event && contextEventId > -1) {

      if (eventId < contextEventId) {
        throw new Error('Event lower than last event on storeEvent action');
      }

      if (!context.initialEventId) {
        // This should never happen
        throw new Error('No initialEventId on context');
      }

      if (event.event.event.id < context.initialEventId) {
        throw new Error('Event lower than initial event on storeEvent action');
      }
    }

    return event.event;
  },
});

/*
 * This action is used to send an ACK event to the socket actor
 */
export const sendAck = sendTo(getSocketRefFromContext,
  (context: Context, _event) => {
    if (!context.event) {
      throw new Error('No event in context, can\'t send ack');
    }

    return {
      type: EventTypes.WEBSOCKET_SEND_EVENT,
      event: createSendAckMessage(context.event.event.id),
    }
  });


/*
 * Updates the cache with the last processed event (from the context)
 */
export const updateCache = (context: Context) => {
  if (!context.txCache) {
    throw new Error('TxCache was not initialized');
  }

  const fullNodeEvent = context.event as StandardFullNodeEvent;
  if (!fullNodeEvent) {
    return;
  }
  const { metadata, hash } = fullNodeEvent.event.data;
  const hashedTxData = hashTxData(metadata);

  context.txCache.set(hash, hashedTxData);
};

/*
 * Starts the ping timer in the healthcheck actor
*/
export const startHealthcheckPing = sendTo(
  getHealthcheckRefFromContext,
  { type: EventTypes.HEALTHCHECK_EVENT, event: { type: 'START' } },
);

/*
 * Stops the ping timer in the healthcheck actor
*/
export const stopHealthcheckPing = sendTo(
  getHealthcheckRefFromContext,
  { type: EventTypes.HEALTHCHECK_EVENT, event: { type: 'STOP' } },
);

/*
 * Logs the event as an error log
 */
export const logEventError = (_context: Context, event: Event) => logger.error(bigIntUtils.JSONBigInt.stringify(event));
