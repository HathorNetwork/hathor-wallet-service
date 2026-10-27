/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';
import { randomBytes } from 'crypto';
import { Context, Handler } from 'aws-lambda';
import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import {
  addAlert,
  isShieldedCryptoProviderRegistered,
  MISSING_SHIELDED_PROVIDER_ALERT,
  Severity,
} from '@wallet-service/common';
import { shieldedCryptoLoadError } from '@src/shieldedCrypto';
import { getWalletsNeedingSweep, markWalletSweepRunning } from '@src/db/shielded';
import {
  commitShieldedRecoveries,
  findAndRewindShielded,
  runRecoveryTransaction,
  ShieldedRecoveryFailure,
} from '@src/shieldedRecovery';
import { ensureShieldedCryptoProvider } from '@src/shieldedCrypto';
import { closeDbConnection, getDbConnection } from '@src/utils';
import createDefaultLogger from '@src/logger';

/** Wallets read per selection query. */
const WALLET_PAGE = 50;

/** Stop starting new wallets with less than this left on the invocation. */
const STOP_MARGIN_MS = 60_000;

/** Stop rewinding a wallet with less than this left, keeping time to commit what opened. */
const REWIND_STOP_MARGIN_MS = 30_000;

/** Set once this container has reported a missing provider. */
let missingProviderAlerted = false;

/** Clear the missing-provider report guard — for test isolation. */
export const resetSweepMissingProviderAlert = (): void => {
  missingProviderAlerted = false;
};

/** Most failed outputs listed in the run's alert; `count` carries the total. */
const ALERT_LIST_CAP = 10;

export interface SweepRunOutcome {
  wallets: number;
  recovered: number;
  failed: number;
  missed: number;
  /** Wallets whose catch-up threw; each is left flagged for the next run. */
  errored: number;
}

/**
 * Each lock wait inside a wallet's commit, in seconds. MySQL's default (50 s)
 * would outlast the time a run keeps for the commit.
 */
const COMMIT_LOCK_WAIT_SECONDS = 5;

/** Don't run a commit again after a lock conflict with less than this left. */
const COMMIT_RETRY_MARGIN_MS = 15_000;

type WalletFailure = ShieldedRecoveryFailure & { walletId: string };

/**
 * The statement that flags the given addresses again, for an operator to run
 * once whatever failed their outputs is fixed (see the PR's retry policy).
 */
const reflagStatement = (addresses: string[]): string => (
  "UPDATE `address` SET `catchup_state` = 'pending' WHERE `bip32_account` = 2 AND `address` IN ("
  + addresses.map((address) => `'${address}'`).join(', ')
  + ')'
);

/**
 * Catch up one wallet: rewind the outputs on its flagged CTSpend addresses,
 * then commit what opened and mark the catch-up done, in one transaction.
 * Each output is tried once per flag: a miss or a failure is not retried
 * until something flags its address again.
 *
 * A wallet with more to rewind than the invocation has time for commits what
 * it reached and stays `running`; promoted outputs drop out of the next run's
 * query, so each run gets further.
 *
 * Failures are recorded (in `failures`, and logged) before the commit: they
 * are already marked `recovery_failed`, and the run reporting them must not
 * depend on the commit, or on the run, getting any further.
 */
const sweepWallet = async (
  mysql: ServerlessMysql,
  walletId: string,
  logger: Logger,
  timeLeftMs: () => number,
  failures: WalletFailure[],
) => {
  await markWalletSweepRunning(mysql, walletId);
  const sweep = await findAndRewindShielded(mysql, walletId, logger, undefined, {
    onlyFlagged: true,
    shouldStop: () => timeLeftMs() < REWIND_STOP_MARGIN_MS,
  });
  if (sweep.skipped) {
    // The provider went away mid-run. The rows stay `running`, so the next
    // run takes the wallet again.
    return sweep;
  }
  if (sweep.failures.length > 0) {
    failures.push(...sweep.failures.map((f) => ({ ...f, walletId })));
    logger.error('Shielded catch-up marked outputs of a wallet recovery_failed', {
      walletId,
      count: sweep.failures.length,
      outputs: sweep.failures.slice(0, ALERT_LIST_CAP),
    });
  }
  await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, walletId, sweep.recoveries, {
    onlyPromoted: true,
    finishSweep: !sweep.truncated,
  }), {
    lockWaitSeconds: COMMIT_LOCK_WAIT_SECONDS,
    canRetry: () => timeLeftMs() > COMMIT_RETRY_MARGIN_MS,
  });
  if (sweep.truncated) {
    logger.info('Shielded catch-up of a wallet ran out of time; the next run continues it', { walletId });
  }
  return sweep;
};

/** Send the run's alerts. Never throws: a failed alert is logged. */
const reportRun = async (
  logger: Logger,
  outcome: SweepRunOutcome,
  failures: WalletFailure[],
  errored: { walletId: string; error: string }[],
) => {
  logger.info('Shielded catch-up sweep finished', { ...outcome });
  if (errored.length > 0) {
    // A wallet that fails every run would otherwise only show in the logs,
    // while its shielded balance never catches up.
    try {
      await addAlert(
        'Shielded catch-up sweep could not finish wallets',
        `The catch-up of ${errored.length} wallet(s) failed and was left for the next run. `
        + `First: ${errored[0].walletId} — ${errored[0].error}`,
        Severity.MAJOR,
        { count: errored.length, wallets: errored.slice(0, ALERT_LIST_CAP), source: 'wallet-service' },
        logger,
      );
    } catch (e) {
      logger.error('Failed to send the catch-up sweep alert', { error: String(e) });
    }
  }
  if (failures.length > 0) {
    // A sender alone can cause an asset mismatch, so a run whose failures are
    // all of that kind does not page.
    const senderMade = failures.every((f) => f.assetMismatch);
    const wallets = [...new Set(failures.map((f) => f.walletId))];
    // Each output is tried once per flag (the daemon's in-line attempt, then
    // this one), and a failure here is deterministic, so retrying every run
    // would only repeat it. Once the cause is fixed, re-flagging the addresses
    // has the next run try them again.
    const addresses = [...new Set(failures.map((f) => f.address))];
    try {
      await addAlert(
        'Shielded recovery failed',
        `${failures.length} shielded output(s) across ${wallets.length} `
        + 'wallet(s) could not be recovered by the catch-up sweep and were marked recovery_failed. '
        + `First: ${failures[0].txId}:${failures[0].index} — ${failures[0].error}. `
        + 'They are not retried until their addresses are flagged again (see reflag_sql).',
        senderMade ? Severity.MINOR : Severity.MAJOR,
        {
          count: failures.length,
          wallet_count: wallets.length,
          wallet_ids: wallets.slice(0, ALERT_LIST_CAP),
          outputs: failures.slice(0, ALERT_LIST_CAP).map((f) => ({
            wallet_id: f.walletId,
            tx_id: f.txId,
            index: f.index,
            address: f.address,
            mode: f.mode,
            token_id: f.tokenId,
            error: f.error,
          })),
          reflag_sql: reflagStatement(addresses),
          source: 'wallet-service',
        },
        logger,
      );
    } catch (e) {
      logger.error('Failed to send the catch-up sweep alert', { error: String(e) });
    }
  }
};

/**
 * Catch up every ready wallet the daemon or a load flagged, until the
 * invocation runs short of time.
 *
 * Wallets are taken in id order from a random point, wrapping round once, so
 * a wallet that always runs out the clock cannot keep the ones after it from
 * ever being reached. A wallet whose catch-up throws is left flagged.
 *
 * Reports once for the whole run, even when a selection query throws partway
 * (the error still propagates). Misses never page from here: unlike a load,
 * nothing the wallet's owner did started this run, so a miss cannot be told
 * from a foreign sender's output.
 */
export const runShieldedSweep = async (
  mysql: ServerlessMysql,
  logger: Logger,
  timeLeftMs: () => number,
  startAfter: string = randomBytes(32).toString('hex'),
): Promise<SweepRunOutcome> => {
  const outcome: SweepRunOutcome = { wallets: 0, recovered: 0, failed: 0, missed: 0, errored: 0 };
  await ensureShieldedCryptoProvider(logger);
  if (!isShieldedCryptoProviderRegistered()) {
    // This function is packaged on its own, so its binary can be missing even
    // where the load's is not. Once per container.
    logger.error('Shielded catch-up sweep skipped: no shielded crypto provider is registered');
    if (!missingProviderAlerted) {
      missingProviderAlerted = true;
      try {
        await addAlert(
          MISSING_SHIELDED_PROVIDER_ALERT.title,
          MISSING_SHIELDED_PROVIDER_ALERT.message,
          MISSING_SHIELDED_PROVIDER_ALERT.severity,
          { load_error: shieldedCryptoLoadError(), source: 'wallet-service-sweep' },
          logger,
        );
      } catch (e) {
        logger.error('Failed to report the missing shielded crypto provider', { error: String(e) });
      }
    }
    return outcome;
  }

  const failures: WalletFailure[] = [];
  const errored: { walletId: string; error: string }[] = [];
  const seen = new Set<string>();
  let cursor = startAfter;
  let wrapped = false;
  try {
    sweep: for (;;) {
      const page = await getWalletsNeedingSweep(mysql, cursor, WALLET_PAGE);
      if (page.length === 0) {
        if (wrapped) break;
        wrapped = true;
        cursor = '';
        continue;
      }
      for (const walletId of page) {
        if (seen.has(walletId) || timeLeftMs() < STOP_MARGIN_MS) break sweep;
        seen.add(walletId);
        try {
          const result = await sweepWallet(mysql, walletId, logger, timeLeftMs, failures);
          if (result.skipped) break sweep;
          outcome.wallets += 1;
          outcome.recovered += result.recovered;
          outcome.failed += result.failed;
          outcome.missed += result.missed;
        } catch (e) {
          outcome.errored += 1;
          errored.push({ walletId, error: String(e) });
          logger.error('Shielded catch-up of a wallet failed; it stays flagged', { walletId, error: String(e) });
        }
      }
      cursor = page[page.length - 1];
    }
  } finally {
    await reportRun(logger, outcome, failures, errored);
  }
  return outcome;
};

const mysql = getDbConnection();

/** Scheduled entry point (see `shieldedCatchupSweep` in serverless.yml). */
export const handler: Handler = async (_event: unknown, context: Context): Promise<SweepRunOutcome> => {
  const logger = createDefaultLogger();
  try {
    return await runShieldedSweep(mysql, logger, () => context.getRemainingTimeInMillis());
  } finally {
    await closeDbConnection(mysql);
  }
};
