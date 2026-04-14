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
import { getDbConnection } from '../db';

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
 *
 * 4. Scheduled balance validation — when BALANCE_VALIDATION_ENABLED is true,
 *    periodically runs a single SQL query that joins address_balance against
 *    SUM(address_tx_history.balance) and reports rows where the two disagree.
 *    Bounded by LIMIT, so a catastrophic mismatch produces a sample, not a
 *    flood. Errors never crash the daemon.
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

  // ── Scheduled balance validation ──────────────────────────────────────────────
  //
  // One SQL query per tick. The DB does the pairing (LEFT JOIN), the math
  // (native BIGINT, no precision loss), and the consistency snapshot (single
  // statement = one read view). The query is bounded by LIMIT so a catastrophic
  // mismatch produces a sample, not a megabyte of payload.
  //
  // If a run exceeds the interval the in-flight guard skips the next tick
  // rather than overlapping. DISCONNECTED clears the timer; an in-flight
  // SELECT runs to completion and releases its connection — harmless.
  //
  // Sample size note: 100 is intentional. Any non-zero count means we'll dive
  // into the data with our own queries anyway; the alert just needs to prove
  // something is wrong and give a representative starting point.
  const BALANCE_VALIDATION_SAMPLE_LIMIT = 100;
  const BALANCE_VALIDATION_SQL = `
    SELECT
        ab.address,
        ab.token_id                                                AS tokenId,
        CAST(ab.unlocked_balance + ab.locked_balance AS SIGNED)    AS balanceSum,
        CAST(COALESCE(SUM(h.balance), 0) AS SIGNED)                AS historySum
    FROM \`address_balance\` ab
    LEFT JOIN \`address_tx_history\` h
           ON h.address  = ab.address
          AND h.token_id = ab.token_id
          AND h.voided   = FALSE
    WHERE ab.transactions > 0
    GROUP BY ab.address, ab.token_id
    HAVING balanceSum != historySum
    LIMIT ${BALANCE_VALIDATION_SAMPLE_LIMIT}
  `;

  let balanceValidationTimer: ReturnType<typeof setInterval> | null = null;
  let isValidating = false;

  const runBalanceValidation = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mysql: any;
    try {
      mysql = await getDbConnection();
      const [rows] = await mysql.query(BALANCE_VALIDATION_SQL);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const samples = rows as any[];

      if (samples.length > 0) {
        const truncated = samples.length === BALANCE_VALIDATION_SAMPLE_LIMIT;
        const countLabel = truncated ? `${BALANCE_VALIDATION_SAMPLE_LIMIT}+` : String(samples.length);
        logger.error(`[monitoring] Balance validation found ${countLabel} mismatch(es)`, { samples });
        await addAlert(
          'Balance validation found mismatches',
          `Found ${countLabel} balance mismatch(es)${truncated ? ' (sample capped)' : ''}`,
          Severity.MAJOR,
          { samples, truncated },
          logger,
        );
      } else {
        logger.info('[monitoring] Balance validation complete, no mismatches found');
      }
    } catch (err) {
      logger.error(`[monitoring] Balance validation error: ${err}`);
    } finally {
      if (mysql) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (mysql as any).release();
        } catch (releaseErr) {
          logger.warn(`[monitoring] Balance validation: connection release failed: ${releaseErr}`);
        }
      }
    }
  };

  const startBalanceValidation = () => {
    if (!config.BALANCE_VALIDATION_ENABLED) return;
    stopBalanceValidation();

    logger.info('[monitoring] Starting scheduled balance validation');
    balanceValidationTimer = setInterval(async () => {
      if (isValidating) return; // prior run still going — skip this tick
      isValidating = true;
      try {
        await runBalanceValidation();
      } finally {
        isValidating = false;
      }
    }, config.BALANCE_VALIDATION_INTERVAL_MS);
  };

  const stopBalanceValidation = () => {
    if (balanceValidationTimer) {
      clearInterval(balanceValidationTimer);
      balanceValidationTimer = null;
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
        startBalanceValidation();
        break;

      case 'DISCONNECTED':
        logger.info('[monitoring] WebSocket disconnected — stopping timers');
        isConnected = false;
        stopIdleCheck();
        clearStuckTimer();
        stopBalanceValidation();
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
    stopBalanceValidation();
  };
};
