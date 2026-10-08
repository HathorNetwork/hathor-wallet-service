/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import {
  rewindAmount,
  rewindFully,
  addAlert,
  Severity,
  ShieldedOutputMode,
  Bip32Account,
  isShieldedCryptoProviderRegistered,
  MISSING_SHIELDED_PROVIDER_ALERT,
  ShieldedScanMissError,
  ShieldedAssetMismatchError,
} from '@wallet-service/common';
import { ensureShieldedCryptoProvider, shieldedCryptoLoadError } from '@src/shieldedCrypto';
import {
  countRecoveredShieldedOutputs,
  getShieldedOutputsToRecover,
  lockWalletAddresses,
  promoteShieldedTxOutputs,
  markShieldedTxOutputRecoveryFailed,
  rebuildShieldedAddressBalances,
  rebuildShieldedAddressTxHistory,
  rebuildWalletBalance,
  rebuildWalletTxHistory,
  ShieldedOutputToRecover,
  ShieldedRecovery,
} from '@src/db/shielded';
import { lockAddressBalancesForUpdate } from '@src/db';
import { beginTransaction, commitTransaction, rollbackTransaction } from '@src/db/utils';

/** A shielded output, as the recovery alerts identify it. */
export interface ShieldedOutputRef {
  txId: string;
  index: number;
  mode: ShieldedOutputMode;
  /** Known up front for AmountShielded; null for FullyShielded. */
  tokenId: string | null;
}

/** An owned output that could not be recovered and was marked `recovery_failed`. */
export interface ShieldedRecoveryFailure extends ShieldedOutputRef {
  /** Its token does not match its asset commitment: the sender's doing alone. */
  assetMismatch: boolean;
  error: string;
}

export interface RecoverOutcome {
  txId: string;
  index: number;
  address: string;
  recovered: boolean;
  /**
   * True when the wallet's scan key did not open the output. Not a failure:
   * the output was left as it was rather than marked `recovery_failed`.
   */
  missed: boolean;
  /** Set when the output was marked `recovery_failed`. */
  failure?: ShieldedRecoveryFailure;
  /** Revealed token + value, set only when `recovered` is true. */
  tokenId?: string;
  value?: bigint;
}

/**
 * Rewind a single owned shielded output with the wallet's scan key, revealing
 * its value and token. It is not promoted here: promotion has to commit
 * together with the balance rebuilds (see `commitShieldedRecoveries`), and the
 * rewind is the slow part, so it runs outside any transaction. On any rewind
 * failure the output is marked `recovery_failed` (that changes no balance) and
 * the failure is returned for the caller to report once per load — this never
 * throws, so a bad output can't abort a whole catch-up batch.
 *
 * A scan miss is the exception: nothing shows the output is the wallet's (see
 * `ShieldedScanMissError`). It is left as it was and returned as `missed`.
 *
 * AmountShielded (mode 1) already knows its token from `token_data`; FullyShielded
 * (mode 2) recovers the token from the rewind itself.
 */
export const rewindShieldedOutput = async (
  mysql: ServerlessMysql,
  walletId: string,
  output: ShieldedOutputToRecover,
  logger: Logger,
): Promise<RecoverOutcome> => {
  const base = { txId: output.txId, index: output.index, address: output.address };
  try {
    let value: bigint;
    let tokenId: string;

    if (output.mode === ShieldedOutputMode.AmountShielded) {
      if (output.tokenId === null) {
        throw new Error('AmountShielded output is missing its token id');
      }
      const r = await rewindAmount({
        scanPrivkey: output.scanPrivkey,
        ephemeralPubkey: output.ephemeralPubkey,
        commitment: output.commitment,
        rangeProof: output.rangeProof,
        tokenId: output.tokenId,
      });
      value = r.value;
      tokenId = output.tokenId;
    } else {
      if (output.assetCommitment === null) {
        throw new Error('FullyShielded output is missing its asset commitment');
      }
      const r = await rewindFully({
        scanPrivkey: output.scanPrivkey,
        ephemeralPubkey: output.ephemeralPubkey,
        commitment: output.commitment,
        rangeProof: output.rangeProof,
        assetCommitment: output.assetCommitment,
      });
      value = r.value;
      tokenId = r.tokenUid; // canonicalized by rewindFully (native HTR folded to "00")
    }

    return { ...base, recovered: true, missed: false, tokenId, value };
  } catch (e) {
    const ref = { txId: output.txId, index: output.index, mode: output.mode, tokenId: output.tokenId };
    if (e instanceof ShieldedScanMissError) {
      logger.warn('Shielded output did not open with its wallet\'s scan key', { ...ref, walletId });
      return { ...base, recovered: false, missed: true };
    }
    // The mark must not throw either: a transient DB blip here would otherwise
    // escape the catch-up loop and abort the whole batch. A swallowed mark just
    // leaves the output non-recovered, so the next catch-up re-drives it.
    try {
      await markShieldedTxOutputRecoveryFailed(mysql, output.txId, output.index);
    } catch (markErr) {
      logger.error('Marking a shielded output recovery_failed threw; leaving it for re-drive', {
        ...ref,
        walletId,
        error: String(markErr),
      });
    }
    return {
      ...base,
      recovered: false,
      missed: false,
      failure: { ...ref, assetMismatch: e instanceof ShieldedAssetMismatchError, error: String(e) },
    };
  }
};

/** Most outputs listed in one alert; `count` carries the total. */
const ALERT_LIST_CAP = 10;

/** Set once this process has reported the missing provider. */
let missingProviderAlerted = false;

/** Clear the missing-provider report guard — for test isolation. */
export const resetMissingProviderAlert = (): void => {
  missingProviderAlerted = false;
};

/**
 * Report the absent provider once per process. Delivery is best-effort:
 * `addAlert` logs and swallows a failed SQS send, so there is nothing to retry
 * on and the guard is taken either way.
 */
const reportMissingProvider = async (walletId: string, logger: Logger): Promise<void> => {
  logger.warn('Shielded catch-up skipped: no shielded crypto provider is registered', { walletId });
  if (missingProviderAlerted) return;
  missingProviderAlerted = true;
  await addAlert(
    MISSING_SHIELDED_PROVIDER_ALERT.title,
    MISSING_SHIELDED_PROVIDER_ALERT.message,
    MISSING_SHIELDED_PROVIDER_ALERT.severity,
    { wallet_id: walletId, load_error: shieldedCryptoLoadError(), source: 'wallet-service' },
    logger,
  );
};

/**
 * Find and rewind all of a wallet's not-yet-recovered shielded outputs — a
 * registration catch-up that also re-drives any `recovery_failed` rows, so an
 * error-restart needs no separate reset. Pages forward with a (tx_id, index)
 * keyset cursor: a re-driven output that fails again stays in the set, so the
 * cursor (rather than set membership) is what guarantees the loop advances and
 * terminates. Never throws — a failed output is marked + alerted and counted.
 */
export interface SweepOutcome {
  /** Outputs rewound successfully; promoted only by `commitShieldedRecoveries`. */
  recovered: number;
  /** The outputs behind `recovered`. */
  recoveries: ShieldedRecovery[];
  failed: number;
  /** Outputs the wallet's scan key did not open; left as they were. */
  missed: number;
  /** The outputs behind `missed`. */
  misses: ShieldedOutputRef[];
  /** The outputs behind `failed`. */
  failures: ShieldedRecoveryFailure[];
  /**
   * True when the sweep never ran because no crypto provider is registered.
   * Distinguishes "nothing to do" from "could not even look", so the caller
   * does not record the catch-up as complete.
   */
  skipped: boolean;
}

const emptySweep = (): SweepOutcome => ({
  recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: false,
});

/** `txId:index`, the key `exclude` and the de-duplication use. */
const outputKey = (o: { txId: string; index: number }): string => `${o.txId}:${o.index}`;

/** The keys of every output a sweep handled, whatever the outcome. */
export const sweptOutputs = (sweep: SweepOutcome): Set<string> => new Set([
  ...sweep.recoveries.map(outputKey),
  ...sweep.misses.map(outputKey),
  ...sweep.failures.map(outputKey),
]);

export const findAndRewindShielded = async (
  mysql: ServerlessMysql,
  walletId: string,
  logger: Logger,
  pageSize = 100,
  /** Outputs to skip, by `txId:index`: ones an earlier sweep of the same load handled. */
  exclude: ReadonlySet<string> = new Set(),
): Promise<SweepOutcome> => {
  // With no provider every rewind throws, and recording the outputs as
  // recovery_failed would strand them: the daemon's promote helper only
  // advances rows that are still `unowned`. Leave them untouched for a later
  // catch-up and report one alert for the whole sweep instead of one per output.
  await ensureShieldedCryptoProvider(logger);
  if (!isShieldedCryptoProviderRegistered()) {
    await reportMissingProvider(walletId, logger);
    return { ...emptySweep(), skipped: true };
  }

  const recoveries: ShieldedRecovery[] = [];
  const misses: ShieldedOutputRef[] = [];
  const failures: ShieldedRecoveryFailure[] = [];
  let after: { txId: string; index: number } | undefined;
  for (;;) {
    const page = await getShieldedOutputsToRecover(mysql, walletId, pageSize, after);
    if (page.length === 0) break;
    for (const output of page) {
      if (exclude.has(outputKey(output))) continue;
      const outcome = await rewindShieldedOutput(mysql, walletId, output, logger);
      if (outcome.recovered) {
        recoveries.push({ txId: output.txId, index: output.index, value: outcome.value!, tokenId: outcome.tokenId! });
      } else if (outcome.missed) {
        misses.push({ txId: output.txId, index: output.index, mode: output.mode, tokenId: output.tokenId });
      } else if (outcome.failure) failures.push(outcome.failure);
    }
    const last = page[page.length - 1];
    after = { txId: last.txId, index: last.index };
  }
  return {
    recovered: recoveries.length,
    recoveries,
    failed: failures.length,
    missed: misses.length,
    misses,
    failures,
    skipped: false,
  };
};

/** How many times a recovery commit is run again after losing a lock conflict. */
const COMMIT_RETRIES = 3;

const isLockConflict = (e: unknown): boolean => {
  const errno = (e as { errno?: unknown } | null)?.errno;
  return errno === 1213 || errno === 1205;
};

/**
 * A handle whose queries all go to `mysql`'s current connection and fail if it
 * is lost.
 *
 * serverless-mysql answers a lost connection by running the query again on a
 * new one, silently. Inside a transaction that runs it — and every statement
 * after it — outside the transaction, each committing on its own, while the
 * final COMMIT or ROLLBACK applies to nothing. A recovery commit split that
 * way can leave an output promoted but not credited, which halts the daemon.
 * On this handle a lost connection is an error, and the server discards the
 * transaction.
 */
const pinConnection = async (mysql: ServerlessMysql): Promise<ServerlessMysql> => {
  await mysql.connect();
  const client = mysql.getClient();
  const query = (sql: string, values?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    client.query(sql, values, (err: unknown, results: unknown) => (err ? reject(err) : resolve(results)));
  });
  return { query } as unknown as ServerlessMysql;
};

/**
 * Run `work` as one transaction on a pinned connection (see `pinConnection`),
 * again from the start if it loses a lock conflict (a deadlock, errno 1213, or
 * a lock wait timeout, 1205) — it locks a wallet's rows while the daemon
 * writes to them, so it can. Any other error, or a conflict past the retries,
 * rolls back and propagates. `work` must use the handle it is given.
 */
export const runRecoveryTransaction = async <T>(
  mysql: ServerlessMysql,
  logger: Logger,
  work: (tx: ServerlessMysql) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    const tx = await pinConnection(mysql);
    await beginTransaction(tx);
    try {
      const result = await work(tx);
      await commitTransaction(tx);
      return result;
    } catch (e) {
      try {
        await rollbackTransaction(tx);
      } catch (rollbackError) {
        // The connection is gone, and the server discarded the transaction
        // with it. Report what actually failed, not the rollback.
        logger.warn('Rolling back a recovery commit failed', { error: String(rollbackError) });
      }
      if (!isLockConflict(e) || attempt >= COMMIT_RETRIES) throw e;
      logger.warn('Recovery commit lost a lock conflict; running it again', {
        attempt: attempt + 1, error: String(e),
      });
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
};

/**
 * Promote rewound outputs and rebuild the wallet's balances and history, as one
 * unit. Must run inside the caller's transaction (see `runRecoveryTransaction`).
 *
 * Promotion and the rebuilds have to commit together. A promoted output is
 * debited from its current state when the daemon spends, unlocks or voids it,
 * so a promoted output not yet credited to `address_balance` underflows the
 * unsigned balance and halts sync.
 *
 * Lock order, chosen so conflicts with the daemon stay rare; both sides retry
 * the ones that remain:
 *  1. the wallet's `address` rows, which fixes the wallet's address set. A
 *     daemon ingest involving the wallet holds these from its involvement
 *     write to its commit, so it serialises here. The daemon's unlock (which
 *     takes `tx_output` then `address_balance`, as we do) and void (which
 *     reaches `address` last) can still conflict with us;
 *  2. promote each recovery (only rows still unpromoted and not voided);
 *  3. the addresses' `address_balance` rows, including pairs that don't exist
 *     yet (next-key locks), so no daemon delta lands mid-rebuild;
 *  4. rebuild the CTSpend addresses' shielded history (first, since the
 *     balance rebuild counts its rows) and balances, then the wallet's totals
 *     and history over every one of its addresses.
 *
 * Returns how many outputs were actually promoted.
 */
export const commitShieldedRecoveries = async (
  mysql: ServerlessMysql,
  walletId: string,
  recoveries: ShieldedRecovery[],
): Promise<number> => {
  const owned = await lockWalletAddresses(mysql, walletId);
  const promoted = await promoteShieldedTxOutputs(mysql, recoveries);
  const addresses = owned.map((a) => a.address);
  await lockAddressBalancesForUpdate(mysql, addresses);
  const ctSpendAddresses = owned
    .filter((a) => a.bip32Account === Bip32Account.CTSpend)
    .map((a) => a.address);
  await rebuildShieldedAddressTxHistory(mysql, ctSpendAddresses);
  await rebuildShieldedAddressBalances(mysql, ctSpendAddresses);
  await rebuildWalletBalance(mysql, walletId, addresses);
  await rebuildWalletTxHistory(mysql, walletId, addresses);
  return promoted;
};

/**
 * Rewind a wallet's not-yet-recovered shielded outputs and commit what opened,
 * rebuilding its balances and history from current DB state. Everything is
 * recompute-from-source, so a repeat (or an error-restart) is safe.
 */
export const reconstructWallet = async (
  mysql: ServerlessMysql,
  walletId: string,
  logger: Logger,
): Promise<SweepOutcome> => {
  const sweep = await findAndRewindShielded(mysql, walletId, logger);
  await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, walletId, sweep.recoveries));
  return sweep;
};

const dedupeByOutput = <T extends ShieldedOutputRef>(items: T[]): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(`${item.txId}:${item.index}`, item);
  return [...seen.values()];
};

const toAlertOutputs = (items: (ShieldedOutputRef & { error?: string })[]) => (
  items.slice(0, ALERT_LIST_CAP).map((o) => ({
    tx_id: o.txId,
    index: o.index,
    mode: o.mode,
    token_id: o.tokenId,
    ...(o.error === undefined ? {} : { error: o.error }),
  }))
);

const sendAlert = async (
  logger: Logger,
  title: string,
  message: string,
  severity: Severity,
  metadata: Record<string, unknown>,
): Promise<void> => {
  try {
    await addAlert(title, message, severity, metadata, logger);
  } catch (e) {
    logger.error('Failed to send a shielded recovery alert', { title, error: String(e) });
  }
};

/**
 * Report what a load's sweeps could not recover, once for the whole load.
 *
 * The sweeps overlap — a load runs one, then a settle sweep that re-drives
 * the same rows — so outputs are counted once each. Never throws.
 *
 * - Failures send one alert. It pages unless every failure is an asset
 *   mismatch, which a sender alone can cause.
 * - Misses page only on the pattern of a scan key that does not match the
 *   client's: misses and not a single recovered output for the wallet. A
 *   miss alone cannot be told from a foreign sender, which anyone can be;
 *   a load, by contrast, is triggered by the wallet's owner only.
 */
export const reportShieldedSweeps = async (
  mysql: ServerlessMysql,
  walletId: string,
  sweeps: SweepOutcome[],
  logger: Logger,
): Promise<void> => {
  const failures = dedupeByOutput(sweeps.flatMap((s) => s.failures));
  const misses = dedupeByOutput(sweeps.flatMap((s) => s.misses));

  if (failures.length > 0) {
    logger.error('Shielded outputs failed to recover during load', { walletId, failed: failures.length });
    const senderMade = failures.every((f) => f.assetMismatch);
    await sendAlert(
      logger,
      'Shielded recovery failed',
      `${failures.length} shielded output(s) of wallet ${walletId} could not be recovered and were `
      + `marked recovery_failed. First: ${failures[0].txId}:${failures[0].index} — ${failures[0].error}`,
      senderMade ? Severity.MINOR : Severity.MAJOR,
      {
        wallet_id: walletId,
        count: failures.length,
        outputs: toAlertOutputs(failures),
        source: 'wallet-service',
      },
    );
  }

  if (misses.length === 0) return;
  let recovered: number;
  try {
    recovered = await countRecoveredShieldedOutputs(mysql, walletId);
  } catch (e) {
    logger.error('Could not count recovered shielded outputs; not paging on misses', {
      walletId, error: String(e),
    });
    return;
  }
  logger.warn('Shielded outputs did not open with their wallet\'s scan key during load', {
    walletId, missed: misses.length, recovered,
  });
  if (recovered > 0) return;
  await sendAlert(
    logger,
    'Shielded outputs did not open with their wallet\'s scan key',
    `${misses.length} shielded output(s) paid to wallet ${walletId} did not open with its scan key, `
    + 'and none of its shielded outputs has. The scan key stored for it may not match the one its '
    + 'client derived.',
    Severity.MAJOR,
    {
      wallet_id: walletId,
      missed: misses.length,
      recovered,
      outputs: toAlertOutputs(misses),
      source: 'wallet-service',
    },
  );
};
