/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Context, Event, EventTypes, FullNodeEventTypes } from '../types';
import { hashTxData } from '../utils';
import { METADATA_DIFF_EVENT_TYPES } from '../services';
import getConfig from '../config';
import logger from '../logger';

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was an IGNORE event
 */
export const metadataIgnore = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataIgnore guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.IGNORE;
};

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was a TX_VOIDED event
 */
export const metadataVoided = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataVoided guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.TX_VOIDED;
};

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was a TX_UNVOIDED event, which means the tx was voided
 * and then got unvoided
 */
export const metadataUnvoided = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataUnvoided guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.TX_UNVOIDED;
};

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was a TX_NEW event, which means that we should insert
 * this transaction on the database
 */
export const metadataNewTx = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataNewTx guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.TX_NEW;
};

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was a TX_FIRST_BLOCK event, which means that we should insert
 * the height of this transaction to the database
 */
export const metadataFirstBlock = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataFirstBlock guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.TX_FIRST_BLOCK;
};

/*
 * This guard is used during the `handlingMetadataChanged` to check if
 * the result was a NC_EXEC_VOIDED event, which means nc_execution changed
 * from 'success' to something else (pending, null, etc.) during a reorg.
 * We need to delete any nano-created tokens for this transaction.
 */
export const metadataNcExecVoided = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.METADATA_DECIDED) {
    throw new Error(`Invalid event type on metadataNcExecVoided guard: ${event.type}`);
  }

  return event.event.type === METADATA_DIFF_EVENT_TYPES.NC_EXEC_VOIDED;
};

/*
 * This guard is used on the `idle` state when an event is received
 * from the fullnode to detect if this event is a VERTEX_METADATA_CHANGED
 * event
 */
export const metadataChanged = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on metadataChanged guard: ${event.type}`);
  }

  return event.event.event.type === FullNodeEventTypes.VERTEX_METADATA_CHANGED;
};

/*
 * This guard is used on the `idle` state when an event is received
 * from the fullnode to detect if this event is a NEW_VERTEX_ACCEPTED
 * event
 */
export const vertexAccepted = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on vertexAccepted guard: ${event.type}`);
  }

  return event.event.event.type === FullNodeEventTypes.NEW_VERTEX_ACCEPTED;
};

/*
 * This guard is used on each event that is received from the fullnode to detect
 * if the received peer_id is the same as we expect (from an env var)
 */
export const invalidPeerId = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on invalidPeerId guard: ${event.type}`);
  }
  const { FULLNODE_PEER_ID } = getConfig();

  // @ts-ignore
  const isInvalid = event.event.peer_id !== FULLNODE_PEER_ID;

  if (isInvalid) {
    logger.error(`Invalid peer id. Expected ${FULLNODE_PEER_ID}, got ${event.event.peer_id}`);
  }

  return isInvalid;
};

/*
 * This guard is used on each event that is received from the fullnode to detect
 * if the received network is the same as we expect (from an env var)
 */
export const invalidNetwork = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on invalidNetwork guard: ${event.type}`);
  }
  const { FULLNODE_NETWORK } = getConfig();

  const isInvalid = event.event.network !== FULLNODE_NETWORK;

  if (isInvalid) {
    logger.error(`Invalid network. Expected ${FULLNODE_NETWORK}, got ${event.event.network}`);
  }

  return isInvalid;
};

/*
 * This guard is used on each event that is received from the fullnode to detect
 * if the received stream_id is the same as we expect (from an env var).
 * This makes sure that the order of the events is the same.
 */
export const invalidStreamId = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on invalidStreamId guard: ${event.type}`);
  }
  const { STREAM_ID } = getConfig();

  const isInvalid = event.event.stream_id !== STREAM_ID;

  if (isInvalid) {
    logger.error(`Invalid stream id. Expected ${STREAM_ID}, got ${event.event.stream_id}`);
  }

  return isInvalid;
}

export const websocketDisconnected = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.WEBSOCKET_EVENT) {
    throw new Error(`Invalid event type on websocketDisconnected guard: ${event.type}`);
  }

  if (event.event.type === 'DISCONNECTED') {
    return true;
  }

  return false;
};

/*
 * This guard is used in the `idle` state to detect if the transaction in the
 * received event is a vertex removed event, indicating that we should remove
 * the transaction from our database
 */
export const vertexRemoved = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on vertexRemvoed guard: ${event.type}`);
  }

  return event.event.event.type === FullNodeEventTypes.VERTEX_REMOVED;
};

/*
 * This guard is used in the `idle` state to detect if the transaction in the
 * received event is voided, this can serve many functions, one of them is to
 * ignore transactions that we don't have on our database but are already voided
 */
export const voided = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on voided guard: ${event.type}`);
  }

  if (event.event.event.type !== FullNodeEventTypes.VERTEX_METADATA_CHANGED
    && event.event.event.type !== FullNodeEventTypes.NEW_VERTEX_ACCEPTED) {
    return false;
  }

  const fullNodeEvent = event.event.event;
  const { metadata: { voided_by } } = fullNodeEvent.data;

  return voided_by.length > 0;
};

/*
 * This guard is used to check our transaction cache to see if any of the fields
 * we monitor are changed.
 *
 * The idea is to ignore, without querying the database, events that don't change
 * any of the fields we are interested on
 */
export const unchanged = (context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on unchanged guard: ${event.type}`);
  }

  if (event.event.event.type !== FullNodeEventTypes.VERTEX_METADATA_CHANGED
    && event.event.event.type !== FullNodeEventTypes.NEW_VERTEX_ACCEPTED) {

    // Not unchanged
    return false;
  }

  const { data } = event.event.event;

  const txCache = context.txCache;
  if (!txCache) {
    throw new Error('txCache is not initialized in context');
  }

  const txHashFromCache = txCache.get(data.hash);
  // Not on the cache, it's not unchanged.
  if (!txHashFromCache) {
    return false;
  }

  const txHashFromEvent = hashTxData(data.metadata);

  return txHashFromCache === txHashFromEvent;
};

/*
 * This guard is used to detect if the event is a REORG_STARTED event
 */
export const reorgStarted = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on reorgStarted guard: ${event.type}`);
  }

  return event.event.event.type === FullNodeEventTypes.REORG_STARTED;
};

/*
 * This guard checks if the checkForMissedEvents service found new events
 * that we missed due to network packet loss
 */
export const hasNewEvents = (_context: Context, event: any) => {
  if (!event.data) {
    return false;
  }

  return event.data.hasNewEvents === true;
};

/*
 * This guard is used to detect if the event is a TOKEN_CREATED event
 */
export const tokenCreated = (_context: Context, event: Event) => {
  if (event.type !== EventTypes.FULLNODE_EVENT) {
    throw new Error(`Invalid event type on tokenCreated guard: ${event.type}`);
  }

  return event.event.event.type === FullNodeEventTypes.TOKEN_CREATED;
};
