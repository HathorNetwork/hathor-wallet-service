/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const DEFAULT_WINDOW_SIZE = 1;

export const createStartStreamMessage = (lastEventId: number) => ({
  type: 'START_STREAM',
  window_size: DEFAULT_WINDOW_SIZE,
  last_ack_event_id: lastEventId,
});

export const createSendAckMessage = (eventId: number) => ({
  type: 'ACK',
  window_size: DEFAULT_WINDOW_SIZE,
  ack_event_id: eventId,
});
