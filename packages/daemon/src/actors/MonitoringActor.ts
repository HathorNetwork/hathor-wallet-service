/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '../logger';
import getConfig from '../config';
import { addAlert, Severity } from '@wallet-service/common';
import { Event, EventTypes } from '../types';

/**
 * MonitoringActor
 *
 * Centralises all runtime health monitoring for the sync state machine.
 * The machine sends MONITORING_EVENTs to this actor; when anomalies are detected
 * the actor fires alerts and, when necessary, sends MONITORING_STUCK_PROCESSING
 * back to the machine to trigger a soft reconnect.
 *
 * Responsibilities:
 *
 * 1. Idle-stream detection — no EVENT_RECEIVED for >IDLE_EVENT_TIMEOUT_MS while
 *    connected fires a MAJOR alert so operators know the fullnode stream may have
 *    stalled without triggering a WebSocket disconnect.
 *
 * 2. Stuck-processing detection — PROCESSING_STARTED begins a one-shot timer;
 *    PROCESSING_COMPLETED cancels it.  If the timer fires the actor fires a
 *    CRITICAL alert and sends MONITORING_STUCK_PROCESSING to the machine, which
 *    transitions to RECONNECTING.  This replaces the per-state XState `after`
 *    blocks that previously scattered this logic across every processing state.
 *
 * 3. Reconnection storm detection — fires a CRITICAL alert when the daemon
 *    reconnects more than RECONNECTION_STORM_THRESHOLD times within
 *    RECONNECTION_STORM_WINDOW_MS.
 */
export default (callback: any, receive: any, config = getConfig()) => {
  logger.info('Starting monitoring actor');

  // ── Idle detection ──────────────────────────────────────────────────────────
  let isConnected = false;
  let lastEventReceivedAt: number | null = null;
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  let idleAlertFired = false;

  const startIdleCheck = () => {
    stopIdleCheck();
    lastEventReceivedAt = Date.now();
    idleAlertFired = false;

    idleCheckTimer = setInterval(async () => {
      if (!isConnected || lastEventReceivedAt === null) return;

      const idleMs = Date.now() - lastEventReceivedAt;
      if (idleMs >= config.IDLE_EVENT_TIMEOUT_MS && !idleAlertFired) {
        idleAlertFired = true;
        const idleMinutes = Math.round(idleMs / 60000);
        logger.warn(
          `[monitoring] No fullnode events received for ${idleMinutes} minutes while WebSocket is connected`,
        );
        addAlert(
          'Daemon Idle — No Events Received',
          `No fullnode events received for ${idleMinutes} minute(s) while the WebSocket is connected. ` +
            'The fullnode stream may be stalled.',
          Severity.MINOR,
          { idleMs: String(idleMs) },
          logger,
        ).catch((err: Error) =>
          logger.error(`[monitoring] Failed to send idle alert: ${err}`),
        );
      }
    }, config.IDLE_EVENT_TIMEOUT_MS);
  };

  const stopIdleCheck = () => {
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = null;
    }
  };

  // ── Stuck-processing detection ───────────────────────────────────────────────
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;

  const startStuckTimer = () => {
    clearStuckTimer();
    stuckTimer = setTimeout(async () => {
      logger.error('[monitoring] State machine stuck in processing state — forcing reconnection');
      try {
        await addAlert(
          'Daemon Stuck In Processing State',
          `The state machine has been processing a single event for more than ` +
            `${Math.round(config.STUCK_PROCESSING_TIMEOUT_MS / 60000)} minute(s). ` +
            'Forcing a reconnection.',
          Severity.MAJOR,
          { timeoutMs: String(config.STUCK_PROCESSING_TIMEOUT_MS) },
          logger,
        );
      } catch (err) {
        logger.error(`[monitoring] Failed to send stuck-processing alert: ${err}`);
      }
      callback({ type: EventTypes.MONITORING_STUCK_PROCESSING });
    }, config.STUCK_PROCESSING_TIMEOUT_MS);
  };

  const clearStuckTimer = () => {
    if (stuckTimer) {
      clearTimeout(stuckTimer);
      stuckTimer = null;
    }
  };

  // ── Reconnection storm detection ─────────────────────────────────────────────
  let reconnectionTimestamps: number[] = [];

  const trackReconnection = () => {
    const now = Date.now();
    reconnectionTimestamps.push(now);

    const windowStart = now - config.RECONNECTION_STORM_WINDOW_MS;
    reconnectionTimestamps = reconnectionTimestamps.filter(t => t >= windowStart);

    if (reconnectionTimestamps.length >= config.RECONNECTION_STORM_THRESHOLD) {
      const windowMinutes = Math.round(config.RECONNECTION_STORM_WINDOW_MS / 60000);
      logger.error(
        `[monitoring] Reconnection storm: ${reconnectionTimestamps.length} reconnections in the last ${windowMinutes} minutes`,
      );
      addAlert(
        'Daemon Reconnection Storm',
        `${reconnectionTimestamps.length} reconnections occurred in the last ${windowMinutes} minute(s). ` +
          'The daemon may be stuck in a reconnection loop.',
        Severity.MAJOR,
        {
          reconnectionCount: String(reconnectionTimestamps.length),
          windowMinutes: String(windowMinutes),
        },
        logger,
      ).catch((err: Error) =>
        logger.error(`[monitoring] Failed to send reconnection storm alert: ${err}`),
      );
    }
  };

  // ── Event handling ────────────────────────────────────────────────────────────
  receive((event: Event) => {
    if (event.type !== EventTypes.MONITORING_EVENT) {
      logger.warn('[monitoring] Unexpected event type received by MonitoringActor');
      return;
    }

    switch (event.event.type) {
      case 'CONNECTED':
        logger.info('[monitoring] WebSocket connected — starting idle-event timer');
        isConnected = true;
        startIdleCheck();
        break;

      case 'DISCONNECTED':
        logger.info('[monitoring] WebSocket disconnected — stopping timers');
        isConnected = false;
        stopIdleCheck();
        clearStuckTimer();
        break;

      case 'EVENT_RECEIVED':
        lastEventReceivedAt = Date.now();
        idleAlertFired = false;
        break;

      case 'PROCESSING_STARTED':
        startStuckTimer();
        break;

      case 'PROCESSING_COMPLETED':
        clearStuckTimer();
        break;

      case 'RECONNECTING':
        trackReconnection();
        break;
    }
  });

  return () => {
    logger.info('Stopping monitoring actor');
    stopIdleCheck();
    clearStuckTimer();
  };
};
