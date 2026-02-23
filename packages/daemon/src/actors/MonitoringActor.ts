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
 * Watches the state machine for anomalies and raises alerts via the alert manager.
 *
 * Monitors:
 * 1. No events received for >IDLE_EVENT_TIMEOUT_MS while WebSocket connected — fires a MAJOR alert
 *    so operators know the fullnode stream may have stalled without a disconnect.
 * 2. Reconnection storm — fires a CRITICAL alert if the daemon reconnects more than
 *    RECONNECTION_STORM_THRESHOLD times within RECONNECTION_STORM_WINDOW_MS.  This catches
 *    pathological thrash-reconnect cycles that would otherwise be silent.
 *
 * The actor receives MONITORING_EVENTs from the SyncMachine:
 *   - CONNECTED:        WebSocket became connected; starts the idle-event timer.
 *   - DISCONNECTED:     WebSocket disconnected; stops the idle-event timer.
 *   - EVENT_RECEIVED:   A fullnode event arrived (resets the idle timer).
 *   - RECONNECTING:     Machine entered RECONNECTING state (used for storm detection).
 */
export default (callback: any, receive: any, config = getConfig()) => {
  logger.info('Starting monitoring actor');

  let isConnected = false;
  let lastEventReceivedAt: number | null = null;
  // Timer that fires when we have been idle (no EVENT_RECEIVED) for too long
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  // Whether we already fired the current idle alert (avoids alert flood)
  let idleAlertFired = false;
  // Rolling list of reconnection timestamps within the storm window
  let reconnectionTimestamps: number[] = [];

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
          Severity.MAJOR,
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

  const trackReconnection = () => {
    const now = Date.now();
    reconnectionTimestamps.push(now);

    // Evict timestamps outside the rolling window
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
        Severity.CRITICAL,
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
        logger.info('[monitoring] WebSocket disconnected — stopping idle-event timer');
        isConnected = false;
        stopIdleCheck();
        break;

      case 'EVENT_RECEIVED':
        lastEventReceivedAt = Date.now();
        idleAlertFired = false;
        break;

      case 'RECONNECTING':
        trackReconnection();
        break;
    }
  });

  return () => {
    logger.info('Stopping monitoring actor');
    stopIdleCheck();
  };
};
