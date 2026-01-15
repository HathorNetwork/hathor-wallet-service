/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebSocket, MessageEvent, ErrorEvent } from 'ws';
import { bigIntUtils } from '@hathor/wallet-lib';
import { FullNodeEvent, FullNodeEventSchema, WebSocketSendEvent } from './types';
import { FULLNODE_HOST, USE_SSL, WINDOW_SIZE, CONNECTION_TIMEOUT_MS } from './config';

export interface BatchConfig {
  batchStart: number;
  batchEnd: number;
  lastDownloaded?: number;  // Resume from this event if set
}

export interface WorkerCallbacks {
  onEvent: (event: FullNodeEvent) => void;
  onProgress: (eventId: number) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

export interface Worker {
  start: () => void;
  stop: () => void;
}

/**
 * Creates a WebSocket worker that downloads a batch of events from the fullnode.
 *
 * @param config - Configuration for the batch to download
 * @param callbacks - Callback functions for event handling
 * @returns Worker object with start and stop methods
 */
export function createWorker(config: BatchConfig, callbacks: WorkerCallbacks): Worker {
  const { batchStart, batchEnd, lastDownloaded } = config;
  const { onEvent, onProgress, onComplete, onError } = callbacks;

  let socket: WebSocket | null = null;
  let isRunning = false;
  let eventsSinceLastAck = 0;
  let lastReceivedEventId = 0;
  let activityTimeout: ReturnType<typeof setTimeout> | null = null;

  const resetActivityTimeout = (): void => {
    if (activityTimeout) {
      clearTimeout(activityTimeout);
    }
    if (isRunning && CONNECTION_TIMEOUT_MS > 0) {
      activityTimeout = setTimeout(() => {
        if (isRunning) {
          onError(new Error(`Connection timeout: no activity for ${CONNECTION_TIMEOUT_MS}ms`));
          stop();
        }
      }, CONNECTION_TIMEOUT_MS);
    }
  };

  const clearActivityTimeout = (): void => {
    if (activityTimeout) {
      clearTimeout(activityTimeout);
      activityTimeout = null;
    }
  };

  const getWsUrl = (): string => {
    const protocol = USE_SSL ? 'wss://' : 'ws://';
    const fullNodeUrl = new URL(`${protocol}${FULLNODE_HOST}`);
    fullNodeUrl.pathname = '/v1a/event_ws';
    return fullNodeUrl.toString();
  };

  const sendMessage = (message: WebSocketSendEvent): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload = bigIntUtils.JSONBigInt.stringify(message);
      socket.send(payload);
    }
  };

  const start = (): void => {
    if (isRunning) {
      return;
    }

    isRunning = true;
    socket = new WebSocket(getWsUrl());

    socket.onopen = () => {
      const lastAckEventId = lastDownloaded ?? (batchStart > 0 ? batchStart - 1 : undefined);
      const startMessage: WebSocketSendEvent = {
        type: 'START_STREAM',
        window_size: WINDOW_SIZE,
        ...(lastAckEventId !== undefined && { last_ack_event_id: lastAckEventId }),
      };
      sendMessage(startMessage);
      resetActivityTimeout();
    };

    socket.onmessage = (socketEvent: MessageEvent) => {
      resetActivityTimeout();
      try {
        const rawData = bigIntUtils.JSONBigInt.parse(socketEvent.data.toString());
        const parseResult = FullNodeEventSchema.safeParse(rawData);

        if (!parseResult.success) {
          // Skip messages that don't conform to event schema (e.g., handshake messages)
          // These are expected at the start of a connection
          console.log(`Skipping non-event message: ${JSON.stringify(rawData).substring(0, 100)}...`);
          return;
        }

        const event = parseResult.data;
        const eventId = event.event.id;

        // Call the event callback
        onEvent(event);

        // Track events for batched ACKs
        eventsSinceLastAck++;
        lastReceivedEventId = eventId;

        // Report progress
        onProgress(eventId);

        // Check if we've reached the end of the batch
        const isComplete = eventId >= batchEnd;

        // Send ACK after receiving WINDOW_SIZE events, or when batch is complete
        if (eventsSinceLastAck >= WINDOW_SIZE || isComplete) {
          const ackMessage: WebSocketSendEvent = {
            type: 'ACK',
            window_size: WINDOW_SIZE,
            ack_event_id: lastReceivedEventId,
          };
          sendMessage(ackMessage);
          eventsSinceLastAck = 0;
        }

        if (isComplete) {
          onComplete();
          stop();
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socket.onerror = (error: ErrorEvent) => {
      onError(new Error(`WebSocket error: ${error.message}`));
    };

    socket.onclose = () => {
      if (isRunning) {
        // Unexpected close - report as error
        onError(new Error('WebSocket connection closed unexpectedly'));
      }
      isRunning = false;
      socket = null;
    };
  };

  const stop = (): void => {
    isRunning = false;
    clearActivityTimeout();
    if (socket) {
      socket.close();
      socket = null;
    }
  };

  return { start, stop };
}
