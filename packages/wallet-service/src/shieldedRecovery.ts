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
  isShieldedCryptoProviderRegistered,
  MISSING_SHIELDED_PROVIDER_ALERT,
  ShieldedScanMissError,
} from '@wallet-service/common';
import { ensureShieldedCryptoProvider, shieldedCryptoLoadError } from '@src/shieldedCrypto';
import {
  getShieldedOutputsToRecover,
  markShieldedTxOutputRecovered,
  markShieldedTxOutputRecoveryFailed,
  rebuildShieldedAddressBalances,
  rebuildShieldedAddressTxHistory,
  rebuildWalletBalance,
  rebuildWalletTxHistory,
  ShieldedOutputToRecover,
} from '@src/db/shielded';

export interface RecoverOutcome {
  txId: string;
  index: number;
  address: string;
  recovered: boolean;
  /**
   * True when the wallet's scan key did not open the output. Not a failure:
   * the output was left `unowned` rather than marked `recovery_failed`.
   */
  missed: boolean;
  /** Revealed token + value, set only when `recovered` is true. */
  tokenId?: string;
  value?: bigint;
}

/**
 * Recover a single owned shielded output: rewind the commitment with the
 * wallet's scan key, then mark the `tx_output` recovered (revealing value +
 * token). On any rewind failure the output is marked `recovery_failed` and an
 * alert is emitted for the on-call retry helper — recovery is never allowed to
 * throw, so a bad output can't abort a whole catch-up batch.
 *
 * A scan miss is the exception: the output is not addressed to this wallet's
 * scan key, which is not a failure to retry. It is left as it was and reported
 * as `missed`, for the sweep to alert on once.
 *
 * AmountShielded (mode 1) already knows its token from `token_data`; FullyShielded
 * (mode 2) recovers the token from the rewind itself.
 */
export const recoverShieldedOutput = async (
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

    await markShieldedTxOutputRecovered(mysql, output.txId, output.index, { value, tokenId });
    return { ...base, recovered: true, missed: false, tokenId, value };
  } catch (e) {
    if (e instanceof ShieldedScanMissError) {
      logger.warn('Shielded output not addressed to its owner\'s scan key', {
        txId: output.txId, index: output.index, walletId,
      });
      return { ...base, recovered: false, missed: true };
    }
    // The failure-reporting path must not throw either: a transient DB/SQS blip here
    // would otherwise escape the catch-up loop and abort the whole batch. A swallowed
    // mark just leaves the output non-recovered, so the next catch-up re-drives it.
    try {
      await markShieldedTxOutputRecoveryFailed(mysql, output.txId, output.index);
      await addAlert(
        'Shielded recovery failed',
        `Failed to rewind shielded output ${output.txId}:${output.index} for wallet ${walletId}`,
        Severity.MAJOR,
        {
          tx_id: output.txId,
          index: output.index,
          wallet_id: walletId,
          error: String(e),
          source: 'wallet-service',
        },
        logger,
      );
    } catch (reportErr) {
      logger.error('Shielded recovery failure-reporting threw; leaving output for re-drive', {
        txId: output.txId,
        index: output.index,
        walletId,
        error: String(reportErr),
      });
    }
    return { ...base, recovered: false, missed: false };
  }
};

/** Most outputs listed in one scan-miss alert; `count` carries the total. */
const MISSED_ALERT_LIST_CAP = 10;

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
  recovered: number;
  failed: number;
  /** Outputs the wallet's scan key did not open; left as they were. */
  missed: number;
  /**
   * True when the sweep never ran because no crypto provider is registered.
   * Distinguishes "nothing to do" from "could not even look", so the caller
   * does not record the catch-up as complete.
   */
  skipped: boolean;
}

export const findAndRewindShielded = async (
  mysql: ServerlessMysql,
  walletId: string,
  logger: Logger,
  pageSize = 100,
): Promise<SweepOutcome> => {
  // With no provider every rewind throws, and recording the outputs as
  // recovery_failed would strand them: the daemon's promote helper only
  // advances rows that are still `unowned`. Leave them untouched for a later
  // catch-up and report one alert for the whole sweep instead of one per output.
  await ensureShieldedCryptoProvider(logger);
  if (!isShieldedCryptoProviderRegistered()) {
    await reportMissingProvider(walletId, logger);
    return { recovered: 0, failed: 0, missed: 0, skipped: true };
  }

  let recovered = 0;
  let failed = 0;
  const missed: { txId: string; index: number }[] = [];
  let after: { txId: string; index: number } | undefined;
  for (;;) {
    const page = await getShieldedOutputsToRecover(mysql, walletId, pageSize, after);
    if (page.length === 0) break;
    for (const output of page) {
      const outcome = await recoverShieldedOutput(mysql, walletId, output, logger);
      if (outcome.recovered) recovered += 1;
      else if (outcome.missed) missed.push({ txId: output.txId, index: output.index });
      else failed += 1;
    }
    const last = page[page.length - 1];
    after = { txId: last.txId, index: last.index };
  }

  // One alert per sweep. A sender that did not encrypt to the wallet's scan
  // key explains one miss; misses across a wallet's outputs point at a scan
  // key here that does not match the one the client derived.
  if (missed.length > 0) {
    try {
      await addAlert(
        'Shielded output not addressed to its owner\'s scan key',
        `${missed.length} shielded output(s) of wallet ${walletId} did not open with its scan key; `
        + 'they were left as they were.',
        Severity.MAJOR,
        {
          wallet_id: walletId,
          count: missed.length,
          outputs: missed.slice(0, MISSED_ALERT_LIST_CAP),
          source: 'wallet-service',
        },
        logger,
      );
    } catch (e) {
      logger.error('Failed to report shielded scan misses', { walletId, error: String(e) });
    }
  }
  return { recovered, failed, missed: missed.length, skipped: false };
};

/**
 * One-time seed of a wallet's balances + history from current DB state, unified
 * across the two derivation paths. Legacy addresses are already daemon-
 * maintained, so they only feed the wallet-level aggregation; CT-spend addresses
 * are first found + rewound and their `address_*` rebuilt from `tx_output`.
 * Everything is recompute-from-source, so a repeat (or an error-restart) is safe.
 *
 * Passing an empty `ctSpendAddresses` (an old client with no CT keys) yields a
 * clean legacy-only reconstruction.
 */
export const reconstructWallet = async (
  mysql: ServerlessMysql,
  walletId: string,
  legacyAddresses: string[],
  ctSpendAddresses: string[],
  logger: Logger,
): Promise<SweepOutcome> => {
  let rewind: SweepOutcome = { recovered: 0, failed: 0, missed: 0, skipped: false };
  if (ctSpendAddresses.length > 0) {
    rewind = await findAndRewindShielded(mysql, walletId, logger);
    await rebuildShieldedAddressBalances(mysql, ctSpendAddresses);
    await rebuildShieldedAddressTxHistory(mysql, ctSpendAddresses);
  }

  const allAddresses = [...legacyAddresses, ...ctSpendAddresses];
  await rebuildWalletBalance(mysql, walletId, allAddresses);
  await rebuildWalletTxHistory(mysql, walletId, allAddresses);
  return rewind;
};
