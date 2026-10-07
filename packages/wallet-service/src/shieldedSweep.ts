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
  Severity,
} from '@wallet-service/common';
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
 * Catch up one wallet: rewind the outputs on its flagged CTSpend addresses,
 * then commit what opened and mark the catch-up done, in one transaction.
 * Each output is tried once per flag: a miss or a failure is not retried
 * until something flags its address again.
 */
const sweepWallet = async (mysql: ServerlessMysql, walletId: string, logger: Logger) => {
  await markWalletSweepRunning(mysql, walletId);
  const sweep = await findAndRewindShielded(mysql, walletId, logger, undefined, { onlyFlagged: true });
  if (sweep.skipped) {
    // The provider went away mid-run. The rows stay `running`, so the next
    // run takes the wallet again.
    return sweep;
  }
  await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, walletId, sweep.recoveries, {
    onlyPromoted: true,
    finishSweep: true,
  }));
  return sweep;
};

/**
 * Catch up every ready wallet the daemon or a load flagged, until the
 * invocation runs short of time.
 *
 * Wallets are taken in id order from a random point, wrapping round once, so
 * a wallet that always runs out the clock cannot keep the ones after it from
 * ever being reached. A wallet whose catch-up throws is left flagged.
 *
 * Reports once for the whole run. Misses never page from here: unlike a load,
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
    // The load and the daemon already page on a missing provider; once per
    // container here would only repeat them.
    logger.error('Shielded catch-up sweep skipped: no shielded crypto provider is registered');
    return outcome;
  }

  const failures: (ShieldedRecoveryFailure & { walletId: string })[] = [];
  const seen = new Set<string>();
  let cursor = startAfter;
  let wrapped = false;
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
        const result = await sweepWallet(mysql, walletId, logger);
        outcome.wallets += 1;
        outcome.recovered += result.recovered;
        outcome.failed += result.failed;
        outcome.missed += result.missed;
        failures.push(...result.failures.map((f) => ({ ...f, walletId })));
      } catch (e) {
        outcome.errored += 1;
        logger.error('Shielded catch-up of a wallet failed; it stays flagged', { walletId, error: String(e) });
      }
    }
    cursor = page[page.length - 1];
  }

  logger.info('Shielded catch-up sweep finished', { ...outcome });
  if (failures.length > 0) {
    // A sender alone can cause an asset mismatch, so a run whose failures are
    // all of that kind does not page.
    const senderMade = failures.every((f) => f.assetMismatch);
    try {
      await addAlert(
        'Shielded recovery failed',
        `${failures.length} shielded output(s) across ${new Set(failures.map((f) => f.walletId)).size} `
        + 'wallet(s) could not be recovered by the catch-up sweep and were marked recovery_failed. '
        + `First: ${failures[0].txId}:${failures[0].index} — ${failures[0].error}`,
        senderMade ? Severity.MINOR : Severity.MAJOR,
        {
          count: failures.length,
          outputs: failures.slice(0, ALERT_LIST_CAP).map((f) => ({
            wallet_id: f.walletId,
            tx_id: f.txId,
            index: f.index,
            mode: f.mode,
            token_id: f.tokenId,
            error: f.error,
          })),
          source: 'wallet-service',
        },
        logger,
      );
    } catch (e) {
      logger.error('Failed to send the catch-up sweep alert', { error: String(e) });
    }
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
