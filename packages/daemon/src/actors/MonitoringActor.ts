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
 * the actor fires alerts and, when necessary, sends MONITORING_IDLE_TIMEOUT back
 * to the machine to trigger a graceful shutdown.
 *
 * Responsibilities:
 *
 * 1. Idle-stream detection — no EVENT_RECEIVED for >IDLE_EVENT_TIMEOUT_MS while
 *    connected fires a MAJOR alert so operators know the fullnode stream may have
 *    stalled without triggering a WebSocket disconnect.
 *
 * 2. Stuck-processing detection — PROCESSING_STARTED begins a one-shot timer;
 *    PROCESSING_COMPLETED cancels it.  If the timer fires the actor fires a
 *    MAJOR alert; the machine keeps running so that a long-running handler
 *    (e.g. a large reorg) is allowed to finish.
 *
 * 3. Reconnection storm detection — fires a MAJOR alert when the daemon
 *    reconnects more than RECONNECTION_STORM_THRESHOLD times within
 *    RECONNECTION_STORM_WINDOW_MS.  Duplicate alerts are suppressed for
 *    STORM_ALERT_COOLDOWN_MS (1 min) to avoid spamming the alerting system.
 */
export default (callback: any, receive: any, config = getConfig()) => {
  logger.info('Starting monitoring actor');

  const idleTimeoutMs = config.IDLE_EVENT_TIMEOUT_MS;
  const stuckTimeoutMs = config.STUCK_PROCESSING_TIMEOUT_MS;
  const stormThreshold = config.RECONNECTION_STORM_THRESHOLD;
  const stormWindowMs = config.RECONNECTION_STORM_WINDOW_MS;

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
      // Interval is idleTimeoutMs/2 so the worst-case detection lag is 1.5×timeout
      if (!isConnected || lastEventReceivedAt === null) return;

      const idleMs = Date.now() - lastEventReceivedAt;
      if (idleMs >= idleTimeoutMs && !idleAlertFired) {
        idleAlertFired = true;
        const idleMinutes = Math.round(idleMs / 60000);
        logger.error(
          `[monitoring] No fullnode events received for ${idleMinutes} minutes while WebSocket is connected — terminating`,
        );
        addAlert(
          'Daemon Idle — No Events Received',
          `No fullnode events received for ${idleMinutes} minute(s) while the WebSocket is connected. ` +
            'Terminating the process so Kubernetes can restart it.',
          Severity.MAJOR,
          { idleMs: String(idleMs) },
          logger,
        ).finally(() => {
          callback({ type: EventTypes.MONITORING_IDLE_TIMEOUT });
        });
      }
    }, Math.floor(idleTimeoutMs / 2));
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
      logger.error('[monitoring] State machine stuck in processing state');
      addAlert(
        'Daemon Stuck In Processing State',
        `The state machine has been processing a single event for more than ` +
          `${Math.round(stuckTimeoutMs / 60000)} minute(s).`,
        Severity.MAJOR,
        { timeoutMs: String(stuckTimeoutMs) },
        logger,
      ).catch((err: Error) =>
        logger.error(`[monitoring] Failed to send stuck-processing alert: ${err.message}`),
      );
    }, stuckTimeoutMs);
  };

  const clearStuckTimer = () => {
    if (stuckTimer) {
      clearTimeout(stuckTimer);
      stuckTimer = null;
    }
  };

  // ── Reconnection storm detection ─────────────────────────────────────────────
  const STORM_ALERT_COOLDOWN_MS = 60 * 1000; // suppress duplicate storm alerts for 1 minute
  let reconnectionTimestamps: number[] = [];
  let stormAlertLastFiredAt: number | null = null;

  const trackReconnection = () => {
    const now = Date.now();
    reconnectionTimestamps.push(now);

    const windowStart = now - stormWindowMs;
    reconnectionTimestamps = reconnectionTimestamps.filter(t => t >= windowStart);

    if (reconnectionTimestamps.length >= stormThreshold) {
      if (stormAlertLastFiredAt !== null && now - stormAlertLastFiredAt < STORM_ALERT_COOLDOWN_MS) {
        return; // still within cooldown — do not spam the alerting system
      }
      stormAlertLastFiredAt = now;

      const windowMinutes = Math.round(stormWindowMs / 60000);
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
        logger.error(`[monitoring] Failed to send reconnection storm alert: ${err.message}`),
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
