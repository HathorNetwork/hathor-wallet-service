/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assign, AssignAction, raise, sendTo } from 'xstate';
import { Context, Event } from '../types';
import { get } from 'lodash';
import logger from '../logger';
import { hashTxData } from '../utils';

export const storeInitialState = assign({
  initialEventId: (_context: Context, event: Event) => {
    // @ts-ignore
    return event.data.lastEventId;
  },
});

export const unwrapEvent = assign({
  event: (_context: Context, event: Event) => {
    if (event.type !== 'METADATA_DECIDED') {
      return;
    }

    return event.event.originalEvent.event;
  },
});

export const increaseRetry = assign({
  retryAttempt: (context: Context) => context.retryAttempt + 1,
});

export const getSocketRefFromContext = (context: Context) => {
  if (!context.socket) {
    throw new Error('No socket');
  }

  return context.socket;
};

export const startStream = sendTo(
  getSocketRefFromContext,
  (context: Context, _event: Event) => {
    const lastAckEventId = get(context, 'event.event.id', context.initialEventId);

    return {
      type: 'WEBSOCKET_SEND_EVENT',
      event: {
        type: 'START_STREAM',
        window_size: 1,
        last_ack_event_id: lastAckEventId,
      }
    };
  });

export const clearSocket = assign({
  socket: null,
});

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
      if (event.event.event.id < context.event.event.id) {
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

export const sendAck = sendTo(getSocketRefFromContext,
  (context: Context, _event) => {
    if (!context.event) {
      throw new Error('No event in context, can\'t send ack');
    }

    return {
      type: 'WEBSOCKET_SEND_EVENT',
      event: {
        type: 'ACK',
        window_size: 1,
        ack_event_id: context.event.event.id,
      },
    }
  });

export const metadataDecided = raise((_context: Context, event: Event) => ({
  type: 'METADATA_DECIDED',
  // @ts-ignore
  event: event.data,
}));

export const updateCache = (context: Context) => {
  const fullNodeEvent = context.event;
  if (!fullNodeEvent) {
    return;
  }
  const { metadata, hash }  = fullNodeEvent.event.data;
  const hashedTxData = hashTxData(metadata);

  context.txCache.set(hash, hashedTxData);
};

export const logEventError = (_context: Context, event: Event) => logger.error(event);
