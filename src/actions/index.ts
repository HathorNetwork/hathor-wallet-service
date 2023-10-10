/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assign, AssignAction, raise, sendTo } from 'xstate';
import { Context, Event } from '../machines/types';
import { get } from 'lodash';
import logger from '../logger';

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
    const lastAckEventId = get(context, 'event.id', context.initialEventId);

    return {
      type: 'WEBSOCKET_SEND_EVENT',
      event: {
        message: JSON.stringify({
          type: 'START_STREAM',
          window_size: 1,
          // @ts-ignore
          last_ack_event_id: lastAckEventId,
        }),
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

    if (eventId === -1) return;

    if (contextEventId > -1) {
      // @ts-ignore
      if (event.event.event.id < context.event.event.id) {
        throw new Error('Event lower than last event on storeEvent action');
      }

      // @ts-ignore
      if (event.event.event.id < context.initialEventId) {
        throw new Error('Event lower than initial event on storeEvent action');
      }
    }

    return event.event;
  },
});

export const sendAck = sendTo(getSocketRefFromContext,
  (context: Context, _event) => ({
    type: 'WEBSOCKET_SEND_EVENT',
    event: {
      message: JSON.stringify({
        type: 'ACK',
        window_size: 1,
        // @ts-ignore
        ack_event_id: context.event.event.id,
      }),
    },
  }));

export const metadataDecided = raise((_context: Context, event: Event) => ({
  type: 'METADATA_DECIDED',
  // @ts-ignore
  event: event.data,
}));

export const logEventError = (_context: Context, event: Event) => logger.error(event);
