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
  // Each tick runs a single SQL query that compares address_balance against the
  // sum of non-voided address_tx_history for rows whose `updated_at` falls
  // within the configured lookback window. The DB does the pairing (LEFT JOIN),
  // the math (native BIGINT, no precision loss), and the consistency snapshot
  // (single statement = one read view).
  //
  // Why `updated_at > NOW() - INTERVAL :window SECOND`:
  //   A full-table pass was benchmarked on production data (≈1.5M
  //   address_balance rows, ≈8.3M address_tx_history rows) and took tens of
  //   seconds per tick. The `updated_at` index scopes the outer set to recently
  //   changed rows, which is what a scheduled monitor actually needs — drift
  //   introduced by a bad write will be caught within one tick of the offending
  //   change. updated_at is `ON UPDATE CURRENT_TIMESTAMP` in the schema, so any
  //   write to the row bumps it; correctness of the scope is structural.
  //
  // Trade-off — hot addresses are still expensive:
  //   Scoping limits WHICH addresses we check per tick; it does NOT limit HOW
  //   MUCH history we sum per address. address_tx_history has no covering
  //   index that includes `balance`, so MySQL fetches every non-voided history
  //   row for each recently-changed address via a PK scan on `address`. For
  //   whale addresses with hundreds of thousands of history rows this is a
  //   multi-second per-address cost even when only a handful of addresses
  //   updated in the window.
  //
  //   Because of this, `BALANCE_VALIDATION_ENABLED` is intended to stay
  //   `false` in production. The actor + query are here for ad-hoc / on-demand
  //   runs (local, testnet, or triggered manually), not for a scheduled
  //   in-production job. See #404 for the covering-index perf improvement that
  //   makes ad-hoc runs faster; it is not a prerequisite for "enabling" this
  //   feature, because enabling isn't planned.
  //
  //   Long tail — slow drift on cold rows (balance changed long ago and the
  //   row never touched since) goes undetected by this validator. A separate
  //   full-table sweep is the right mechanism for that; out of scope.
  //
  // The `transactions > 0` filter is intentionally omitted: a row with
  // `transactions = 0` AND non-zero balance is itself a bug (the void cleanup
  // should have deleted it), and we want the validator to surface that.
  // Genuinely-empty rows match `historySum=0` via COALESCE and HAVING drops
  // them.
  //
  // If a run exceeds the interval the in-flight guard skips the next tick
  // rather than overlapping. DISCONNECTED clears the timer; an in-flight
  // SELECT runs to completion and releases its connection — harmless.
  const sampleLimit = config.BALANCE_VALIDATION_SAMPLE_LIMIT;
  const windowSeconds = Math.floor(config.BALANCE_VALIDATION_WINDOW_MS / 1000);
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
    WHERE ab.updated_at > NOW() - INTERVAL ${windowSeconds} SECOND
    GROUP BY ab.address, ab.token_id
    HAVING balanceSum != historySum
    LIMIT ${sampleLimit}
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
        const truncated = samples.length === sampleLimit;
        const countLabel = truncated ? `${sampleLimit}+` : String(samples.length);
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
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger.error(`[monitoring] Balance validation error: ${detail}`);
    } finally {
      if (mysql) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (mysql as any).release();
        } catch (releaseErr) {
          const detail = releaseErr instanceof Error
            ? (releaseErr.stack ?? releaseErr.message)
            : String(releaseErr);
          logger.warn(`[monitoring] Balance validation: connection release failed: ${detail}`);
        }
      }
    }
  };

  // Minimum tick interval. Below this, we'd hammer the DB faster than a
  // validation run can reasonably complete and risk cascading overruns.
  const MIN_BALANCE_VALIDATION_INTERVAL_MS = 1000;

  const startBalanceValidation = () => {
    if (!config.BALANCE_VALIDATION_ENABLED) return;

    const intervalMs = config.BALANCE_VALIDATION_INTERVAL_MS;
    // Guard against misconfig: parseInt('abc') yields NaN, and setInterval(fn, NaN)
    // behaves like delay=0 — a tight loop hammering the DB. Fail loud and stay
    // disabled rather than silently substitute a default; operators should see
    // this and fix the env var.
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_BALANCE_VALIDATION_INTERVAL_MS) {
      logger.error(
        `[monitoring] BALANCE_VALIDATION_INTERVAL_MS=${intervalMs} is invalid `
        + `(must be a finite number >= ${MIN_BALANCE_VALIDATION_INTERVAL_MS}). `
        + 'Scheduled balance validation will NOT run this session.',
      );
      return;
    }

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
    }, intervalMs);
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
