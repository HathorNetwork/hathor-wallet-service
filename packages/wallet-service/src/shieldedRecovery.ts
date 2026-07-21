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
} from '@wallet-service/common';
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
        tokenUid: Buffer.from(output.tokenId, 'hex'),
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
    return { ...base, recovered: true, tokenId, value };
  } catch (e) {
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
    return { ...base, recovered: false };
  }
};

/**
 * Find and rewind all of a wallet's not-yet-recovered shielded outputs — a
 * registration catch-up that also re-drives any `recovery_failed` rows, so an
 * error-restart needs no separate reset. Pages forward with a (tx_id, index)
 * keyset cursor: a re-driven output that fails again stays in the set, so the
 * cursor (rather than set membership) is what guarantees the loop advances and
 * terminates. Never throws — a failed output is marked + alerted and counted.
 */
export const findAndRewindShielded = async (
  mysql: ServerlessMysql,
  walletId: string,
  logger: Logger,
  pageSize = 100,
): Promise<{ recovered: number; failed: number }> => {
  let recovered = 0;
  let failed = 0;
  let after: { txId: string; index: number } | undefined;
  for (;;) {
    const page = await getShieldedOutputsToRecover(mysql, walletId, pageSize, after);
    if (page.length === 0) break;
    for (const output of page) {
      const outcome = await recoverShieldedOutput(mysql, walletId, output, logger);
      if (outcome.recovered) recovered += 1;
      else failed += 1;
    }
    const last = page[page.length - 1];
    after = { txId: last.txId, index: last.index };
  }
  return { recovered, failed };
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
): Promise<{ recovered: number; failed: number }> => {
  let rewind = { recovered: 0, failed: 0 };
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
