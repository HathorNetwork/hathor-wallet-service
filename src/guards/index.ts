/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Context, Event } from "../machines/types";
import { TxCache } from "../machines";
import { hashTxData } from "../utils";

export const metadataIgnore = (_context: Context, event: Event) => {
  if (event.type !== 'METADATA_DECIDED') {
    return false;
  }

  return event.event.type === 'IGNORE';
};

export const metadataVoided = (_context: Context, event: Event) => {
  if (event.type !== 'METADATA_DECIDED') {
    return false;
  }

  return event.event.type === 'TX_VOIDED';
};

export const metadataNewTx = (_context: Context, event: Event) => {
  if (event.type !== 'METADATA_DECIDED') {
    return false;
  }

  return event.event.type === 'TX_NEW';
};

export const metadataFirstBlock = (_context: Context, event: Event) => {
  if (event.type !== 'METADATA_DECIDED') {
    return false;
  }

  return event.event.type === 'TX_FIRST_BLOCK';
};

export const metadataChanged = (_context: Context, event: Event) => {
  if (event.type !== 'FULLNODE_EVENT') {
    return false;
  }

  return event.event.event.type === 'VERTEX_METADATA_CHANGED';
};
export const vertexAccepted = (_context: Context, event: Event) => {
  if (event.type !== 'FULLNODE_EVENT') {
    return false;
  }

  return event.event.event.type === 'NEW_VERTEX_ACCEPTED';
};

// --

export const invalidPeerId = (_context: Context, event: Event) => {
  // @ts-ignore
  return event.event.event.peer_id !== process.env.FULLNODE_PEER_ID;
}
export const invalidStreamId = (_context: Context, event: Event) =>
  // @ts-ignore
  event.event.stream_id !== process.env.STREAM_ID;

export const websocketDisconnected = (_context: Context, event: Event) => {
  if (event.type === 'WEBSOCKET_EVENT'
      && event.event.type === 'DISCONNECTED') {
    return true;
  }

  return false;
};

export const voided = (_context: Context, event: Event) => {
  if (event.type !== 'FULLNODE_EVENT') {
    return false;
  }

  if (event.event.event.type !== 'VERTEX_METADATA_CHANGED'
      && event.event.event.type !== 'NEW_VERTEX_ACCEPTED') {
        return false;
  }

  const fullNodeEvent = event.event.event;
  const { metadata: { voided_by } } = fullNodeEvent.data;

  return voided_by.length > 0;
};

export const unchanged = (_context: Context, event: Event) => {
  if (event.type !== 'FULLNODE_EVENT') {
    return true;
  }

  if (event.event.event.type !== 'VERTEX_METADATA_CHANGED'
      && event.event.event.type !== 'NEW_VERTEX_ACCEPTED') {
    // Not unchanged
    return false;
  }

  const { data } = event.event.event;

  const txHashFromCache = TxCache.get(data.hash);
  // Not on the cache, it's not unchanged.
  if (!txHashFromCache) {
    return false;
  }

  const txHashFromEvent = hashTxData(data.metadata);

  return txHashFromCache === txHashFromEvent;
};
