/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import hathorLib from '@hathor/wallet-lib';
import { Connection as MysqlConnection, PoolConnection } from 'mysql2/promise';
import axios from 'axios';
import { get } from 'lodash';
import {
  NftUtils,
  ShieldedOutputMode,
  RecoveryState,
  isShieldedMode,
  checkShieldedOutputStorable,
  ShieldedStorageCheck,
  EPHEMERAL_PUBKEY_BYTES,
  ShieldedScanMissError,
  ShieldedAssetMismatchError,
} from '@wallet-service/common';
import {
  StringMap,
  Wallet,
  DbTxOutput,
  DbTransaction,
  LastSyncedEvent,
  Event,
  EventTypes,
  Context,
  EventTxInput,
  EventTxOutput,
  WalletStatus,
  FullNodeEventTypes,
  StandardFullNodeEvent,
  EventTxHeader,
  isNanoHeader,
  ShieldedOutput,
} from '../types';
import {
  TxInput,
  Transaction,
  TokenBalanceMap,
  TxOutputWithIndex,
  isDecodedValid,
} from '@wallet-service/common';
import {
  prepareOutputs,
  getInvolvedAddresses,
  getUnifiedBalanceMap,
  ShieldedRecoveryResult,
  ShieldedInputAnomaly,
  partitionShieldedInputs,
  getUnixTimestamp,
  unlockUtxos,
  unlockTimelockedUtxos,
  prepareInputs,
  markLockedOutputs,
  getTokenListFromInputsAndOutputs,
  getWalletBalanceMap,
  validateAddressBalances,
  getWalletBalancesForTx,
  getFullnodeHttpUrl,
  generateAddresses,
  sendRealtimeTx,
} from '../utils';
import {
  getDbConnection,
  addOrUpdateTx,
  addUtxos,
  updateTxOutputSpentBy,
  updateAddressTablesWithTx,
  getTransactionById,
  getUtxosLockedAtHeight,
  addMiner,
  storeTokenInformation,
  getTokenInformation,
  insertTokenCreation,
  getTokensCreatedByTx,
  getReexecNanoTokens,
  deleteTokens,
  getLockedUtxoFromInputs,
  incrementTokensTxCount,
  getAddressWalletInfo,
  addNewAddresses,
  updateWalletTablesWithTx,
  voidTransaction,
  voidAddressTransaction,
  updateLastSyncedEvent as dbUpdateLastSyncedEvent,
  getLastSyncedEvent,
  getTxOutputsFromTx,
  markUtxosAsVoided,
  cleanupVoidedTx,
  getMaxIndicesForWallets,
  setAddressSeqnum,
  getAddressSeqnum,
  unspendUtxos,
  voidWalletTransaction,
  getTxOutputs,
  clearTxProposalForVoidedTx,
  insertTxOutput,
  insertShieldedTxOutputData,
  upsertShieldedAddressObservation,
  findShieldedAddressOwnership,
  findShieldedAddressOwnershipBatch,
  markTxOutputRecovered,
  markTxOutputRecoveryFailed,
  bumpAddressInvolvement,
  decrementAddressInvolvement,
} from '../db';
import {
  rewindAmount,
  rewindFully,
  isShieldedCryptoProviderRegistered,
  MISSING_SHIELDED_PROVIDER_ALERT,
} from '@wallet-service/common';
import getConfig, { VALIDATE_ADDRESS_BALANCES } from '../config';
import logger from '../logger';
import { invokeOnTxPushNotificationRequestedLambda, getDaemonUptime, retryWithBackoff } from '../utils';
import { addAlert, Severity } from '@wallet-service/common';
import { JSONBigInt } from '@hathor/wallet-lib/lib/utils/bigint';

const tracer = trace.getTracer('wallet-service-daemon');

/**
 * How many per-item entries an aggregated alert embeds. The alert body is a
 * single SQS message and the downstream alert manager maps metadata into a much
 * smaller details field, so the list is capped; `count` carries the real total.
 */
const ALERT_LIST_CAP = 10;

/** Set once this process has reported the missing shielded crypto provider. */
let missingProviderAlerted = false;

/** Clear the missing-provider report guard — for test isolation. */
export const resetMissingProviderAlert = (): void => {
  missingProviderAlerted = false;
};

/**
 * Record that the missing provider was already reported — by the startup
 * alert, which carries the load error — so the first shielded vertex does
 * not page for it a second time.
 */
export const markMissingProviderReported = (): void => {
  missingProviderAlerted = true;
};

/**
 * Emit an alert that is deferred past a commit, swallowing any failure.
 *
 * `addAlert` catches a failed SQS *send*, but building the client and the
 * command happens outside that catch, so it can still throw. A throw after
 * `mysql.commit()` would reach the ingest catch, attempt a rollback on an
 * already-committed transaction and report the vertex as failed — turning a
 * reportable condition into a sync halt. Alerting must never change the
 * outcome of work that is already durable.
 */
const emitDeferredAlert = async (
  title: string,
  message: string,
  severity: Severity,
  metadata: unknown,
): Promise<void> => {
  try {
    await addAlert(title, message, severity, metadata, logger);
  } catch (e) {
    logger.error('deferred alert failed to emit', { title, error: String(e) });
  }
};

async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (s) => {
    try {
      return await fn();
    } catch (e) {
      s.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      s.recordException(e as Error);
      throw e;
    } finally {
      s.end();
    }
  });
}

export const METADATA_DIFF_EVENT_TYPES = {
  IGNORE: 'IGNORE',
  TX_VOIDED: 'TX_VOIDED',
  TX_UNVOIDED: 'TX_UNVOIDED',
  TX_NEW: 'TX_NEW',
  TX_FIRST_BLOCK: 'TX_FIRST_BLOCK',
  NC_EXEC_VOIDED: 'NC_EXEC_VOIDED',
};


const DUPLICATE_TX_ALERT_GRACE_PERIOD = 10; // seconds

export const metadataDiff = async (_context: Context, event: Event) => {
  return tracer.startActiveSpan('metadataDiff', async (span) => {
    const fullNodeEvent = (event as Extract<Event, { type: EventTypes.FULLNODE_EVENT }>).event as StandardFullNodeEvent;
    const {
      hash,
      metadata: { voided_by, first_block, nc_execution },
    } = fullNodeEvent.event.data;

    span.setAttribute('tx.hash', hash);

    const isRetryableError = (error: any): boolean => {
      const code = error?.code;
      return code === 'ETIMEDOUT'
        || code === 'ECONNREFUSED'
        || code === 'ECONNRESET'
        || code === 'PROTOCOL_CONNECTION_LOST';
    };

    try {
      return await retryWithBackoff(
        async () => {
          let mysql: PoolConnection | undefined;
          try {
            mysql = await getDbConnection();
            const dbTx: DbTransaction | null = await withSpan('getTransactionById', () => getTransactionById(mysql!, hash));

            if (!dbTx) {
              if (voided_by.length > 0) {
                // No need to add voided transactions
                return {
                  types: [METADATA_DIFF_EVENT_TYPES.IGNORE],
                  originalEvent: event,
                };
              }

              return {
                types: [METADATA_DIFF_EVENT_TYPES.TX_NEW],
                originalEvent: event,
              };
            }

            // Mutually exclusive: voided/unvoided/new take priority
            // Tx is voided
            if (voided_by.length > 0) {
              // Was it voided on the database?
              if (!dbTx.voided) {
                return {
                  types: [METADATA_DIFF_EVENT_TYPES.TX_VOIDED],
                  originalEvent: event,
                };
              }

              return {
                types: [METADATA_DIFF_EVENT_TYPES.IGNORE],
                originalEvent: event,
              };
            }

            // Tx was voided in the database but is not anymore
            if (dbTx.voided && voided_by.length <= 0) {
              return {
                types: [METADATA_DIFF_EVENT_TYPES.TX_UNVOIDED],
                originalEvent: event,
              };
            }

            // Independent changes: collect all into array
            const types: string[] = [];

            // Check if nc_execution changed from 'success' to something else.
            // If the tx has nano-created tokens in the database (tokens where token_id != tx_id),
            // those tokens were created when nc_execution was 'success'.
            // If nc_execution is now NOT 'success', we should delete those tokens.
            if (nc_execution !== 'success') {
              const tokensCreated = await getTokensCreatedByTx(mysql, hash);
              const nanoTokens = tokensCreated.filter(tokenId => tokenId !== hash);

              if (nanoTokens.length > 0) {
                types.push(METADATA_DIFF_EVENT_TYPES.NC_EXEC_VOIDED);
              }
            }

            // Handle first_block changes (NULL -> value OR value -> NULL)
            const eventFirstBlock: string | null = first_block ?? null;
            const dbFirstBlock: string | null = dbTx.first_block ?? null;

            if (eventFirstBlock !== dbFirstBlock) {
              types.push(METADATA_DIFF_EVENT_TYPES.TX_FIRST_BLOCK);
            }

            if (types.length === 0) {
              types.push(METADATA_DIFF_EVENT_TYPES.IGNORE);
            }

            return {
              types,
              originalEvent: event,
            };
          } finally {
            if (mysql) {
              mysql.release();
            }
          }
        },
        {
          maxRetries: 5,
          initialDelayMs: 1000,
          maxDelayMs: 10000,
          backoffMultiplier: 2,
          retryableErrors: isRetryableError,
        },
      );
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      span.recordException(e as Error);
      logger.error('metadataDiff error', { eventId: fullNodeEvent.event.id, error: e });
      return Promise.reject(e);
    } finally {
      span.end();
    }
  });
};

export const isBlock = (version: number): boolean => version === hathorLib.constants.BLOCK_VERSION
  || version === hathorLib.constants.MERGED_MINED_BLOCK_VERSION
  || version === hathorLib.constants.POA_BLOCK_VERSION;

export function isNanoContract(headers: EventTxHeader[]) {
  for (const header of headers) {
    if (isNanoHeader(header)) {
      return true;
    }
  }
  return false;
}

/**
 * Handles a vertex (transaction or block) being accepted by the fullnode.
 *
 * This function processes VERTEX_METADATA_CHANGED and NEW_VERTEX_ACCEPTED events.
 * It stores the transaction in the database, updates wallet balances, and handles
 * various edge cases related to token creation and nano contract execution.
 *
 * Token Deletion Edge Cases:
 *
 * Tokens can be created in three different ways, each requiring different deletion rules:
 *
 * 1. **Pure CREATE_TOKEN_TX (no nano headers)**
 *    - Token created immediately when transaction hits mempool
 *    - Token deletion rule: Delete ONLY when transaction becomes voided
 *    - Example: Standard custom token creation
 *
 * 2. **Pure Nano Contract Transaction**
 *    - Token created via nano contract syscall when nc_execution = 'success'
 *    - Token deletion rules:
 *      a) Delete when first_block changes (handled in handleTokenCreated)
 *         - The token_id might change between reorgs even though tx_id stays the same
 *         - handleTokenCreated deletes old tokens before inserting new ones
 *      b) Delete when nc_execution changes from 'success' to something else
 *         (handled in handleNcExecVoided) - this occurs during reorgs
 *    - Token can be re-created if nano executes successfully again after reorg
 *
 * 3. **Hybrid Transaction (CREATE_TOKEN_TX + Nano Contract)**
 *    - Creates TWO sets of tokens:
 *      a) CREATE_TOKEN_TX token: Received immediately when tx hits mempool (token_id = tx_id)
 *      b) Nano-created tokens: Received when nano executes successfully (token_id ≠ tx_id)
 *    - Token deletion rules:
 *      - CREATE_TOKEN_TX token: Delete ONLY when transaction becomes voided
 *      - Nano-created tokens: Delete when first_block changes (in handleTokenCreated) OR
 *        nc_execution changes from 'success' to something else (in handleNcExecVoided)
 *    - During reorg: Only nano-created tokens are deleted, CREATE_TOKEN_TX token remains
 *    - When voided: BOTH sets of tokens are deleted
 *
 * @param context - The context containing the event and other metadata
 * @param _event - The event being processed (unused, context.event is used instead)
 */
export const handleVertexAccepted = async (context: Context, _event: Event) => {
  return tracer.startActiveSpan('handleVertexAccepted', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      const {
        NETWORK,
        STAGE,
        SERVERLESS_DEPLOY_PREFIX,
        PUSH_NOTIFICATION_ENABLED,
      } = getConfig();

      const fullNodeEvent = context.event as StandardFullNodeEvent;
      const now = getUnixTimestamp();
      const blockRewardLock = context.rewardMinBlocks;

      if (!blockRewardLock) {
        throw new Error('No block reward lock set');
      }

      const fullNodeData = fullNodeEvent.event.data;

      const {
        hash,
        metadata,
        timestamp,
        version,
        weight,
        outputs,
        inputs,
        nonce,
        tokens,
        token_name,
        token_symbol,
        parents,
        headers = [],
      } = fullNodeData;

      span.setAttribute('tx.hash', hash);
      span.setAttribute('tx.version', version);

      // Duplicate check is a read-only lookup and runs outside the transaction
      // so an early return cannot leave a BEGIN open on a pooled connection.
      const dbTx: DbTransaction | null = await withSpan('getTransactionById', () => getTransactionById(mysql!, hash));

      if (dbTx) {
        const daemonUptime = getDaemonUptime();
        // We do not log if the daemon has just started, because it's expected that
        // we receive an initial duplicate transaction from the fullnode in this case.
        if (daemonUptime < DUPLICATE_TX_ALERT_GRACE_PERIOD) {
          return;
        }

        logger.error(`Transaction ${hash} already in the database and the daemon has not been recently restarted (uptime of ${daemonUptime} seconds). This is unexpected.`);

        // This might happen if the service has been recently restarted,
        // so we should raise the alert and just ignore the tx
        return;
      }

      await mysql.beginTransaction();
      try {
        let height: number | null = metadata.height;

        if (!isBlock(version) && !metadata.first_block) {
          height = null;
        }

        const txOutputs: TxOutputWithIndex[] = prepareOutputs(outputs, tokens);
        const txInputs: TxInput[] = prepareInputs(inputs, tokens);

        let heightlock: number | null = null;
        if (isBlock(version)) {
          if (typeof height !== 'number' && !height) {
            throw new Error('Block with no height set in metadata.');
          }

          // unlock older blocks
          const utxos = await getUtxosLockedAtHeight(mysql, now, height);

          if (utxos.length > 0) {
            logger.debug(`Block transaction, unlocking ${utxos.length} locked utxos at height ${height}`);
            await unlockUtxos(mysql, utxos, false);
          }

          // set heightlock
          heightlock = height + blockRewardLock;

          // get the first output address and add miner to the miners table
          // PoA blocks may not have outputs, so we need to check first
          if (outputs.length > 0) {
            const blockRewardOutput = outputs[0];
            if (isDecodedValid(blockRewardOutput.decoded, ['address'])) {
              await addMiner(mysql, blockRewardOutput.decoded!.address, hash);
            }
          }

          // here we check if we have any utxos on our database that is locked but
          // has its timelock < now
          //
          // we've decided to do this here considering that it is acceptable to have
          // a delay between the actual timelock expiration time and the next block
          // (that will unlock it). This delay is only perceived on the wallet as the
          // sync mechanism will unlock the timelocked utxos as soon as they are seen
          // on a received transaction.
          await unlockTimelockedUtxos(mysql, now);
        }

        // Validate the shielded inputs before anything acts on them. A
        // wire-shielded input whose stored row is transparent means the
        // concatenated-index assumption does not hold for the vertex that
        // created that output, and every path below would otherwise mutate the
        // wrong row: the unlock moves value between the locked and unlocked
        // columns (with no re-lock path), and updateTxOutputSpentBy marks a
        // real transparent UTXO spent.
        // Both are committed in this transaction, so the exclusion has to come
        // first — detecting it afterwards would only describe the damage.
        //
        // `getInvolvedAddresses` below deliberately keeps using the raw inputs:
        // the involvement counter is wire-level and the void path reverses it
        // from the same wire set, so filtering here would break that symmetry.
        const shieldedInputAnomalies: ShieldedInputAnomaly[] = [];
        const spendableInputs = await withSpan(
          'partitionShieldedInputs',
          () => partitionShieldedInputs(mysql!, inputs, shieldedInputAnomalies),
        );

        // check if any of the inputs are still marked as locked and update tables accordingly.
        // See remarks on getLockedUtxoFromInputs for more explanation. It's important to perform this
        // before updating the balances
        const lockedInputs = await getLockedUtxoFromInputs(mysql, spendableInputs);
        await unlockUtxos(mysql, lockedInputs, true);

        // add transaction outputs to the tx_outputs table
        markLockedOutputs(txOutputs, now, heightlock !== null);

        // Add the transaction
        const firstBlock: string | null = metadata.first_block ?? null;
        logger.debug('Will add the tx with height', height);
        // TODO: add is_nanocontract to transaction table?
        await withSpan('addOrUpdateTx', () => addOrUpdateTx(
          mysql,
          hash,
          height,
          timestamp,
          version,
          weight,
          firstBlock,
        ));

        // Add utxos
        await withSpan('addUtxos', () => addUtxos(mysql, hash, txOutputs, heightlock));

        // Resolve a shielded output's token_data to the matching token UID.
        // Mirrors the transparent-path logic in `prepareOutputs`: a token_data
        // of 0 selects the native token; otherwise it indexes into `vertex.tokens[]`.
        const shieldedOutputs = fullNodeEvent.event.data.shielded_outputs ?? [];
        const transparentCount = outputs.length;
        const resolveShieldedTokenId = (tokenData: number): string | null => {
          // Out of range for the TINYINT column: the index mask below would
          // otherwise fold it onto a real token and record a false token_id
          // on the parked row.
          if (tokenData < 0 || tokenData > 0xFF) {
            return null;
          }
          const idx = hathorLib.tokensUtils.getTokenIndexFromData(tokenData) - 1;
          if (idx < 0) {
            return hathorLib.constants.NATIVE_TOKEN_UID;
          }
          return tokens[idx] ?? null;
        };

        // Per-shielded-output rewind outcomes collected by the loop below
        // and consumed by the unified balance-map builder. Only owned,
        // successful recoveries land here; unowned outputs and rewind
        // failures contribute nothing to the balance map (involvement is
        // already covered by bumpAddressInvolvement).
        const shieldedRecoveryResults: ShieldedRecoveryResult[] = [];

        // Shielded-recovery failures are collected here and alerted on AFTER
        // the transaction commits, once per vertex. addAlert performs an SQS
        // round-trip, which must not run while the ingest transaction holds
        // tx_output/address row locks.
        const failedShieldedRecoveries: {
          index: number;
          mode: number;
          tokenId: string | null;
          assetMismatch: boolean;
          error: string;
        }[] = [];

        // Read once per vertex, not cached across vertices: a provider can be
        // registered at any time, and a stale `false` would hide real failures.
        const canRewind = isShieldedCryptoProviderRegistered();
        let missingProviderAlertPending = false;
        const shieldedStorageViolations: ({ index: number }
          & Pick<Extract<ShieldedStorageCheck, { storable: false }>, 'scope' | 'reason'>)[] = [];

        // Walk shielded_outputs[] with concatenated index = transparentCount + i.
        // A storable output produces three rows: the `tx_output` row, the
        // `shielded_tx_output_data` satellite carrying the per-output crypto payload,
        // and an `address` observation row (address + involvement only; the
        // CTSpend account and scan key are set when a wallet claims it).
        // It lands in `recovery_state = 'unowned'` and is promoted in-line below
        // when a wallet has claimed the spend address, a crypto provider is
        // registered and the output carries an ephemeral pubkey; otherwise it
        // stays `unowned`.
        //
        // An output that does not fit its columns produces fewer: a satellite-scope
        // violation skips the payload and records `recovery_failed`; an output-scope
        // violation writes no `tx_output` row at all (a timelock violation still
        // leaves its address in the involvement set, which the void path reverses;
        // an address violation leaves nothing). Either way the vertex still
        // ingests — see checkShieldedOutputStorable.
        //
        // An output with no address produces no rows at all — see the check at
        // the top of the loop.
        for (let i = 0; i < shieldedOutputs.length; i++) {
          const so = shieldedOutputs[i];
          const idx = transparentCount + i;

          if (!so.decoded) {
            // The script is not an address script, so no wallet can own this
            // output. Skipped without an alert, like a transparent output
            // whose script does not decode (see prepareOutputs).
            logger.info('Shielded output skipped: its script has no address', { txId: hash, index: idx });
            continue;
          }

          const isAmount = so.mode === ShieldedOutputMode.AmountShielded;

          // Decoded once: the storage guard sizes these exact bytes, and the
          // satellite insert and the rewind consume them unchanged.
          const commitment = Buffer.from(so.commitment, 'hex');
          // An absent ephemeral pubkey is stored as 33 zero bytes, the encoding
          // hathor-core itself uses for "not present" on the wire. Zero bytes
          // that arrive explicitly mean the same, as they do to the sweep.
          const absentPubkey = Buffer.alloc(EPHEMERAL_PUBKEY_BYTES);
          const ephemeralPubkey = so.ephemeral_pubkey
            ? Buffer.from(so.ephemeral_pubkey, 'hex')
            : absentPubkey;
          const hasEphemeralPubkey = !ephemeralPubkey.equals(absentPubkey);
          const rangeProof = Buffer.from(so.range_proof, 'base64');
          const script = Buffer.from(so.script, 'base64');
          const assetCommitment = !isAmount ? Buffer.from(so.asset_commitment, 'hex') : null;
          const surjectionProof = !isAmount ? Buffer.from(so.surjection_proof, 'base64') : null;

          // Reject before any INSERT: an over-cap field raises an error inside
          // this transaction, which reaches the sync machine's terminal state
          // and halts sync for good. Parking the single output keeps the rest
          // of the vertex ingesting.
          const storage = checkShieldedOutputStorable({
            mode: so.mode,
            script,
            range_proof: rangeProof,
            surjection_proof: surjectionProof,
            token_data: isAmount ? so.token_data : null,
            decoded: so.decoded,
          });
          if (!storage.storable) {
            shieldedStorageViolations.push({
              index: idx, scope: storage.scope, reason: storage.reason,
            });
            // Logged here as well as alerted: the alert is only sent after
            // commit, and an output-scope park leaves no row behind.
            logger.error('Shielded output parked: it does not fit its storage columns', {
              txId: hash, index: idx, scope: storage.scope, reason: storage.reason,
            });
            if (storage.scope === 'output') {
              // The violation is on tx_output itself; no row can be written.
              continue;
            }
          }

          // Shielded outputs don't carry a wire-level `locked` flag, so the
          // daemon derives it locally from `decoded.timelock` (if present) and
          // the vertex's `heightlock`. Mirrors the transparent path
          // (`markLockedOutputs` in utils/wallet): locked iff any heightlock
          // is in effect, or the explicit timelock is still in the future.
          const shieldedTimelock = so.decoded.timelock ?? null;
          const shieldedLocked = heightlock !== null
            || (shieldedTimelock !== null && shieldedTimelock > now);

          await insertTxOutput(mysql, {
            tx_id: hash,
            index: idx,
            mode: so.mode,
            address: so.decoded.address,
            value: null,
            token_id: isAmount ? resolveShieldedTokenId(so.token_data) : null,
            authorities: 0,
            timelock: shieldedTimelock,
            heightlock,
            locked: shieldedLocked,
            voided: false,
            recovery_state: storage.storable ? RecoveryState.Unowned : RecoveryState.RecoveryFailed,
          });

          if (!storage.storable) {
            // `recovery_failed` because that is the true state: the crypto
            // payload is never stored, so nothing in this system can rewind
            // this output. The recovery sweep cannot reach it in either state —
            // it inner-joins on `shielded_tx_output_data`, which this output
            // never gets.
            await upsertShieldedAddressObservation(mysql, so.decoded.address);
            continue;
          }

          await insertShieldedTxOutputData(mysql, {
            tx_id: hash,
            index: idx,
            mode: so.mode,
            commitment,
            range_proof: rangeProof,
            script,
            ephemeral_pubkey: ephemeralPubkey,
            token_data: isAmount ? so.token_data : null,
            asset_commitment: assetCommitment,
            surjection_proof: surjectionProof,
          });

          await upsertShieldedAddressObservation(mysql, so.decoded.address);

          // If a wallet has claimed this shielded address, attempt the rewind
          // in line. Success → mark the output recovered with the revealed
          // value/token; failure → mark it recovery_failed and emit an alert.
          //
          // Skip the ownership lookup entirely when no rewind is possible: its
          // only purpose is to decide whether to rewind, and recording the
          // output as recovery_failed would strand it — the promote helper only
          // advances rows that are still `unowned`.
          const owned = canRewind
            ? await findShieldedAddressOwnership(mysql, so.decoded.address)
            : null;
          if (owned && !hasEphemeralPubkey) {
            // No shared secret to rewind from, so the output stays `unowned`
            // and the recovery sweep skips it too. Wallet-lib likewise treats
            // such an output as not the wallet's, but its funds then never
            // show up for the address's owner, so it is traced.
            logger.warn('Shielded output to a claimed address has no ephemeral pubkey; left unowned', {
              txId: hash, index: idx, address: so.decoded.address,
            });
          }
          if (owned && hasEphemeralPubkey) {
            try {
              if (isAmount) {
                const tokenIdHex = resolveShieldedTokenId(so.token_data);
                if (tokenIdHex === null) {
                  throw new Error('AmountShielded token_data does not resolve to a known token');
                }
                const r = await rewindAmount({
                  scanPrivkey: owned.scan_privkey,
                  ephemeralPubkey,
                  commitment,
                  rangeProof,
                  tokenId: tokenIdHex,
                });
                await markTxOutputRecovered(mysql, hash, idx, {
                  value: r.value,
                  token_id: tokenIdHex,
                });
                shieldedRecoveryResults.push({
                  address: so.decoded.address,
                  tokenId: tokenIdHex,
                  value: r.value,
                  locked: shieldedLocked,
                });
              } else {
                const r = await rewindFully({
                  scanPrivkey: owned.scan_privkey,
                  ephemeralPubkey,
                  commitment,
                  rangeProof,
                  // Non-null on this branch: decoded above for every non-amount output.
                  assetCommitment: assetCommitment!,
                });
                const tokenIdHexFull = r.tokenUid; // canonicalized by rewindFully
                await markTxOutputRecovered(mysql, hash, idx, {
                  value: r.value,
                  token_id: tokenIdHexFull,
                });
                shieldedRecoveryResults.push({
                  address: so.decoded.address,
                  tokenId: tokenIdHexFull,
                  value: r.value,
                  locked: shieldedLocked,
                });
              }
            } catch (e) {
              const tokenId = isAmount ? resolveShieldedTokenId(so.token_data) : null;
              if (e instanceof ShieldedScanMissError) {
                // Not a failed recovery: nothing shows the output belongs to
                // this wallet, and anyone can send such an output to a claimed
                // address. It stays `unowned`, the state for outputs that
                // cannot be attributed to the wallet, which keeps
                // `recovery_failed` for outputs that are the wallet's. No alert
                // here, for the same reason: a single miss cannot tell a
                // foreign sender from a scan-key mismatch, so the wallet-service
                // pages on the wallet-level pattern instead.
                logger.warn('Shielded output did not open with its wallet\'s scan key', {
                  txId: hash,
                  index: idx,
                  address: so.decoded.address,
                  walletId: owned.wallet_id,
                  mode: so.mode,
                  tokenId,
                });
              } else {
                await markTxOutputRecoveryFailed(mysql, hash, idx);
                // Defer the alert until after commit — see failedShieldedRecoveries.
                failedShieldedRecoveries.push({
                  index: idx,
                  mode: so.mode,
                  tokenId,
                  assetMismatch: e instanceof ShieldedAssetMismatchError,
                  error: String(e),
                });
              }
            }
          }
        }

        if (!canRewind && shieldedOutputs.length > 0) {
          logger.warn('Shielded outputs ingested without a rewind: no shielded crypto provider is registered', {
            txId: hash,
            shieldedOutputs: shieldedOutputs.length,
          });
          missingProviderAlertPending = true;
        }

        // Bump address.transactions once per involved address using the
        // pure wire-data set (transparent in/out + every shielded out +
        // shielded in spent_output.decoded.address + nano-header addresses).
        // This is now the single canonical writer of the involvement
        // counter — updateAddressTablesWithTx no longer touches the
        // address row directly; it only writes per-token rows.
        const involvedAddresses = getInvolvedAddresses(inputs, outputs, shieldedOutputs, headers, hash);
        await withSpan('bumpAddressInvolvement', () => bumpAddressInvolvement(mysql, involvedAddresses));

        // Mark tx utxos as spent. Kind-agnostic: only uses tx_id+index, so it
        // takes the event inputs — transparent and shielded alike — even though
        // prepareInputs only emits transparent TxInput rows. `spendableInputs`
        // rather than the raw set: the anomalous ones must not be marked spent.
        await withSpan('updateTxOutputSpentBy', () => updateTxOutputSpentBy(mysql, spendableInputs, hash));

        // Genesis tx has no inputs and outputs, so nothing to be updated.
        // Nano contracts contribute an address even without inputs/outputs
        // — covered by involvedAddresses through the header walk.
        // Shielded-credit-only and shielded-spend-only vertices also flow
        // through here because the involvement set always includes any
        // shielded output / input address.
        if (involvedAddresses.size > 0) {
          const tokenList: string[] = getTokenListFromInputsAndOutputs(txInputs, txOutputs);

          // Update transaction count with the new tx
          await incrementTokensTxCount(mysql, tokenList);

          // Unified per-(address, token) balance map. Includes:
          //   - transparent inputs/outputs from prepared lists,
          //   - shielded receives from the in-line rewind results above,
          //   - shielded spend reversals sourced from local tx_output rows
          //     (only for `recovery_state = 'recovered'` rows owned by us),
          //   - header-only addresses seeded with an empty HTR entry.
          const addressBalanceMap: StringMap<TokenBalanceMap> = await getUnifiedBalanceMap(
            mysql,
            txInputs,
            txOutputs,
            shieldedRecoveryResults,
            spendableInputs,
            headers,
          );

          // update address tables (address, address_balance, address_tx_history)
          await withSpan('updateAddressTablesWithTx', () => updateAddressTablesWithTx(mysql, hash, timestamp, addressBalanceMap));

          // for the addresses present on the tx, check if there are any wallets associated
          const addressWalletMap: StringMap<Wallet> = await withSpan('getAddressWalletInfo', () => getAddressWalletInfo(mysql!, Object.keys(addressBalanceMap)));

          const addressesPerWallet = Object.entries(addressWalletMap).reduce(
            (result: StringMap<{ addresses: string[], walletDetails: Wallet }>, [address, wallet]: [string, Wallet]) => {
              const { walletId } = wallet;

              // Initialize the array if the walletId is not yet a key in result
              if (!result[walletId]) {
                result[walletId] = {
                  addresses: [],
                  walletDetails: wallet,
                }
              }

              // Add the current key to the array
              result[walletId].addresses.push(address);

              return result;
            }, {});

          const seenWallets = Object.keys(addressesPerWallet);

          // Convert to array format expected by getMaxIndicesForWallets
          const walletDataArray = Object.entries(addressesPerWallet).map(([walletId, data]) => ({
            walletId,
            addresses: data.addresses
          }));

          // Get all max indices in a single query
          const walletIndices = await getMaxIndicesForWallets(mysql, walletDataArray);

          // Process each wallet
          for (const [walletId, data] of Object.entries(addressesPerWallet)) {
            const { walletDetails } = data;
            const indices = walletIndices.get(walletId);

            if (!indices) {
              // This is unexpected as we just queried for this wallet
              logger.error('Failed to get indices for wallet', { walletId });
              continue;
            }

            // Legacy gap extension reads the legacy pair only — a
            // claimed shielded (CTSpend) index must never drive or suppress
            // legacy derivation. The CT pair feeds the shielded gap
            // extension (follow-up work).
            const { maxLegacyAmongAddresses, maxLegacyWalletIndex } = indices;

            if (maxLegacyAmongAddresses == null || maxLegacyWalletIndex == null) {
              // Do nothing, wallet is most likely not loaded yet.
              if (walletDetails.status === WalletStatus.READY) {
                logger.error('[ERROR] A wallet marked as READY does not have a max wallet index or address index was not found in the database');
              }
              continue;
            }

            const diff = maxLegacyWalletIndex - maxLegacyAmongAddresses;

            if (diff < walletDetails.maxGap) {
              // We need to generate addresses
              const addresses = await generateAddresses(NETWORK as string, walletDetails.xpubkey, maxLegacyWalletIndex + 1, walletDetails.maxGap - diff);
              await addNewAddresses(mysql, walletId, addresses, maxLegacyAmongAddresses);
            }
          }

          // update wallet_balance and wallet_tx_history tables
          const walletBalanceMap: StringMap<TokenBalanceMap> = getWalletBalanceMap(addressWalletMap, addressBalanceMap);
          await withSpan('updateWalletTablesWithTx', () => updateWalletTablesWithTx(mysql!, hash, timestamp, walletBalanceMap));

          // prepare the transaction data to be sent to the SQS queue
          const txData: Transaction = {
            tx_id: hash,
            nonce,
            timestamp,
            version,
            voided: metadata.voided_by.length > 0,
            weight,
            parents,
            inputs: txInputs,
            outputs: txOutputs,
            // The realtime contract carries nano headers only; other header
            // types hold nothing a client acts on.
            headers: headers.filter(isNanoHeader),
            height: metadata.height,
            token_name,
            token_symbol,
            signal_bits: 0, // TODO: we should actually receive this and store in the database
            // Additive realtime fields: a lightweight shielded-output projection
            // (no crypto blobs) and the full involved-address set (reusing the
            // same set bumpAddressInvolvement consumed). Clients intersect
            // `addresses` with their own and refetch.
            // One entry per shielded output, so a client can still count
            // positions: an addressless output reports no address.
            shielded_outputs: shieldedOutputs.map((so) => {
              const decoded = so.decoded ? { address: so.decoded.address } : null;
              // token_data only exists on AmountShielded; FullyShielded hides it.
              return so.mode === ShieldedOutputMode.AmountShielded
                ? { mode: so.mode, token_data: so.token_data, decoded }
                : { mode: so.mode, decoded };
            }),
            addresses: Array.from(involvedAddresses),
          };

          try {
            if (seenWallets.length > 0) {
              await sendRealtimeTx(
                Array.from(seenWallets),
                txData,
              );
            }
          } catch (e) {
            logger.error('Failed to send transaction to SQS queue');
            logger.error(e);
          }

          try {
            if (PUSH_NOTIFICATION_ENABLED) {
              const walletBalanceMap = await getWalletBalancesForTx(mysql, txData, addressBalanceMap);
              const { length: hasAffectWallets } = Object.keys(walletBalanceMap);
              if (hasAffectWallets) {
                invokeOnTxPushNotificationRequestedLambda(walletBalanceMap)
                  .catch((err: Error) => logger.error('Error on invokeOnTxPushNotificationRequestedLambda invocation', err));
              }
            }
          } catch (e) {
            logger.error('Failed to send push notification to wallet-service lambda');
            logger.error(e);
          }

          // NFT detection on transactions that touch shielded data is deferred —
          // shielded NFT detection is technical debt, so skip the handler when the
          // vertex carries any shielded outputs OR spends any shielded input.
          const hasShieldedInputs = inputs.some(
            (input) => input?.spent_output && isShieldedMode(input.spent_output.mode),
          );
          if (shieldedOutputs.length === 0 && !hasShieldedInputs) {
            const network = new hathorLib.Network(NETWORK);

            // Call to process the data for NFT handling (if applicable)
            // This process is not critical, so we run it in a fire-and-forget manner, not waiting for the promise.
            // @ts-ignore - wallet-lib's FullNodeTransaction will be updated to know about the new spent_output union in the next release
            NftUtils.processNftEvent(fullNodeData, STAGE, SERVERLESS_DEPLOY_PREFIX, network, logger)
              .catch((err: unknown) => logger.error('[ALERT] Error processing NFT event', err));
          }
        }

        // Need to check if there is a nano header and update the nc_address's seqnum if needed
        for (const header of headers) {
          if (isNanoHeader(header)) {
            const txseqnum = header.nc_seqnum;
            const cachedSeqnum = await getAddressSeqnum(mysql, header.nc_address);
            if (txseqnum > cachedSeqnum) {
              // The tx seqnum is higher than the cached one so we need to save the tx deqnum
              await setAddressSeqnum(mysql, header.nc_address, header.nc_seqnum);
            }
          }
        }

        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

        await mysql.commit();

        // Transaction committed and its row locks released: now emit the
        // deferred recovery-failure alert, one per vertex. Routed through
        // emitDeferredAlert so an alerting failure cannot be mistaken for an
        // ingest failure. A sender alone can produce an asset mismatch, so a
        // vertex whose failures are all of that kind does not page.
        if (failedShieldedRecoveries.length > 0) {
          const first = failedShieldedRecoveries[0];
          const senderMade = failedShieldedRecoveries.every((f) => f.assetMismatch);
          await emitDeferredAlert(
            'Shielded recovery failed',
            `${failedShieldedRecoveries.length} shielded output(s) of ${hash} paid to a claimed `
            + `address could not be recovered and were marked recovery_failed. First: index `
            + `${first.index} — ${first.error}`,
            senderMade ? Severity.MINOR : Severity.MAJOR,
            {
              tx_id: hash,
              count: failedShieldedRecoveries.length,
              outputs: failedShieldedRecoveries.slice(0, ALERT_LIST_CAP).map((f) => ({
                index: f.index,
                mode: f.mode,
                token_id: f.tokenId,
                error: f.error,
              })),
              source: 'daemon',
            },
          );
        }

        // Deferred past the commit like the recovery-failure alerts: addAlert
        // performs an SQS round-trip, which must not run while the ingest
        // transaction holds row locks. One alert per vertex rather than per
        // output, so a malformed stream cannot become an alert storm.
        if (shieldedStorageViolations.length > 0) {
          const first = shieldedStorageViolations[0];
          await emitDeferredAlert(
            'Shielded output exceeds its storage limits',
            `${shieldedStorageViolations.length} shielded output(s) of ${hash} were not fully `
            + `stored (satellite-scope keeps the tx_output row as recovery_failed; output-scope `
            + `writes no tx_output row). First: index ${first.index}, scope ${first.scope} — ${first.reason}`,
            Severity.MAJOR,
            {
              tx_id: hash,
              count: shieldedStorageViolations.length,
              index: first.index,
              scope: first.scope,
              reason: first.reason,
              violations: shieldedStorageViolations.slice(0, ALERT_LIST_CAP),
              source: 'daemon',
            },
          );
        }

        // One alert per vertex, matching the storage-violation alert above.
        if (shieldedInputAnomalies.length > 0) {
          const first = shieldedInputAnomalies[0];
          await emitDeferredAlert(
            'Shielded input resolved to a non-shielded output',
            `${shieldedInputAnomalies.length} input(s) of ${hash} are declared shielded on the `
            + `wire while the stored row is transparent, so the concatenated-index assumption `
            + `does not hold for the transaction(s) that created those outputs (first: `
            + `${first.txId}). They were excluded before anything read or wrote `
            + `them, so no UTXO was unlocked or marked spent and no balance moved. Their `
            + `addresses do still count toward address.transactions, which the void path `
            + `reverses. First: ${first.txId}:${first.index}, stored mode ${first.storedMode}.`,
            Severity.MAJOR,
            {
              // The spending vertex, whose inputs were excluded. The funding
              // tx whose layout is wrong is in first_input / inputs.
              tx_id: hash,
              count: shieldedInputAnomalies.length,
              first_input: { tx_id: first.txId, index: first.index, stored_mode: first.storedMode },
              // snake_case to match the sibling keys, and capped: the alert body
              // is one SQS message and `count` already carries the total.
              inputs: shieldedInputAnomalies.slice(0, ALERT_LIST_CAP).map((a) => ({
                tx_id: a.txId, index: a.index, stored_mode: a.storedMode,
              })),
              source: 'daemon',
            },
          );
        }

        // Once per process (see `missingProviderAlerted`), not per vertex, and
        // best-effort: addAlert swallows a failed send, so a process that fails
        // to deliver this will not try again.
        if (missingProviderAlertPending && !missingProviderAlerted) {
          missingProviderAlerted = true;
          await emitDeferredAlert(
            MISSING_SHIELDED_PROVIDER_ALERT.title,
            MISSING_SHIELDED_PROVIDER_ALERT.message,
            MISSING_SHIELDED_PROVIDER_ALERT.severity,
            { tx_id: hash, shielded_outputs: shieldedOutputs.length, source: 'daemon' },
          );
        }
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        throw e;
      }
    } catch (e) {
      // Outer catch handles span error tracking for ALL failure paths —
      // including errors thrown before beginTransaction (getDbConnection,
      // getConfig, the duplicate check) that the inner catch never sees.
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      span.recordException(e as Error);
      logger.error('Error handling vertex accepted', e);
      throw e;
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

export const handleVertexRemoved = async (context: Context, _event: Event) => {
  return tracer.startActiveSpan('handleVertexRemoved', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event as StandardFullNodeEvent;

        const {
          hash,
          outputs,
          inputs,
          shielded_outputs: shieldedOutputs = [],
          tokens,
          headers = [],
          version,
        } = fullNodeEvent.event.data;

        span.setAttribute('tx.hash', hash);

        const dbTx: DbTransaction | null = await getTransactionById(mysql, hash);

        if (!dbTx) {
          throw new Error(`VERTEX_REMOVED event received, but transaction ${hash} was not in the database.`);
        }

        logger.info(`[VertexRemoved] Voiding tx: ${hash}`);

        await voidTx(
          mysql,
          hash,
          inputs,
          outputs,
          shieldedOutputs,
          tokens,
          headers,
          version,
        );

        logger.info(`[VertexRemoved] Removing tx from database: ${hash}`);
        await cleanupVoidedTx(mysql, hash);
        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
        await mysql.commit();
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.debug(e);

        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

/**
 * Voids a transaction and all its associated data.
 *
 * This function handles the complete voiding process including:
 * - Marking transaction as voided in database
 * - Marking all UTXOs as voided
 * - Unspending inputs that were spent by this transaction
 * - Updating wallet and address balances
 * - Clearing tx_proposal marks
 * - Deleting ALL tokens created by this transaction
 *
 * Token Deletion Behavior:
 *
 * When a transaction is voided, ALL tokens created by that transaction are deleted,
 * regardless of how they were created:
 *
 * 1. **Pure CREATE_TOKEN_TX**: Deletes the CREATE_TOKEN_TX token (token_id = tx_id)
 *
 * 2. **Pure Nano Contract**: Deletes all tokens created by nano syscalls
 *
 * 3. **Hybrid Transaction (CREATE_TOKEN_TX + Nano)**: Deletes BOTH:
 *    - The CREATE_TOKEN_TX token (token_id = tx_id)
 *    - All nano-created tokens (token_id ≠ tx_id)
 *
 * Important: This deletion is INDEPENDENT of nano contract execution state:
 * - A voided transaction might still have nc_execution = 'success'
 * - Voiding applies to the ENTIRE transaction, so all tokens are deleted
 * - This is different from nano execution state changes, which only delete nano-created tokens
 *
 * @param mysql - Database connection (must be in transaction)
 * @param hash - Transaction hash
 * @param inputs - Transaction inputs
 * @param outputs - Transaction outputs
 * @param tokens - Token UIDs in the transaction
 * @param headers - Transaction headers (for nano contracts)
 * @param version - Transaction version
 */
export const voidTx = async (
  mysql: MysqlConnection,
  hash: string,
  inputs: EventTxInput[],
  outputs: EventTxOutput[],
  shieldedOutputs: ShieldedOutput[],
  tokens: string[],
  headers: EventTxHeader[],
  version: number,
) => {
  const dbTxOutputs: DbTxOutput[] = await withSpan('getTxOutputsFromTx', () => getTxOutputsFromTx(mysql, hash));
  const txOutputs: TxOutputWithIndex[] = prepareOutputs(outputs, tokens);
  const txInputs: TxInput[] = prepareInputs(inputs, tokens);

  const txOutputsWithLocked = txOutputs.map((output) => {
    const dbTxOutput = dbTxOutputs.find((_output) => _output.index === output.index);

    if (!dbTxOutput) {
      throw new Error('Transaction output different from database output!');
    }

    return {
      ...output,
      locked: dbTxOutput.locked,
    };
  });

  // Build shielded output contributions from local tx_output rows.
  // A shielded receive is only credited when it was recovered against an
  // owned address; those same rows must be reversed when the vertex is voided.
  // We read them from the DB now — before markUtxosAsVoided — so the rows
  // are still present and still carry value / token_id.
  //
  // Ownership is resolved in one batch query to avoid N round-trips.
  const candidateRows = dbTxOutputs.filter(
    (r) => r.mode !== 0 && r.recoveryState === RecoveryState.Recovered && r.value !== null && r.tokenId !== null,
  );
  const ownershipMap = await findShieldedAddressOwnershipBatch(
    mysql,
    candidateRows.map((r) => r.address),
  );
  const shieldedRecoveryResults: ShieldedRecoveryResult[] = candidateRows
    .filter((r) => ownershipMap.has(r.address))
    .map((r) => ({
      address: r.address,
      tokenId: r.tokenId!,
      value: r.value!,
      locked: r.locked,
    }));

  const addressBalanceMap: StringMap<TokenBalanceMap> = await getUnifiedBalanceMap(
    mysql,
    txInputs,
    txOutputsWithLocked,
    shieldedRecoveryResults,
    inputs,
    headers,
  );

  await withSpan('voidTransaction', () => voidTransaction(mysql, hash));

  // CRITICAL: markUtxosAsVoided must be called before voidAddressTransaction
  // and voidWalletTransaction as those methods recalculate balances based on
  // the UTXOs table.
  await withSpan('markUtxosAsVoided', () => markUtxosAsVoided(mysql, dbTxOutputs));
  await withSpan('voidAddressTransaction', () => voidAddressTransaction(mysql, hash, addressBalanceMap, version));

  // Reverse the address-grain involvement counter for the SAME set the ingest
  // path bumped via bumpAddressInvolvement.
  const involvedAddresses = getInvolvedAddresses(inputs, outputs, shieldedOutputs, headers, hash);
  await withSpan('decrementAddressInvolvement', () => decrementAddressInvolvement(mysql, involvedAddresses));

  // CRITICAL: Unspend the inputs when voiding a transaction
  // The inputs of the voided transaction need to be marked as unspent
  // But only if they were actually spent by this transaction
  if (inputs.length > 0) {
    await withSpan('unspendInputs', async () => {
      // Batch-fetch all input outputs in a single query, then filter by spentBy.
      // `skipVoided=true` preserves the legacy per-input `getTxOutput(..., voided=FALSE)`
      // semantics — without it, unspendUtxos could clear `spent_by` on already-voided rows.
      const allInputOutputs = await getTxOutputs(
        mysql,
        inputs.map((input) => ({ txId: input.tx_id, index: input.index })),
        true,
      );
      const inputsSpentByThisTx = allInputOutputs.filter((output) => output.spentBy === hash);

      if (inputsSpentByThisTx.length > 0) {
        await unspendUtxos(mysql, inputsSpentByThisTx);
      }
    });
  }

  // CRITICAL: Update wallet balances when voiding a transaction
  await withSpan('voidWalletTransaction', () => voidWalletTransaction(mysql, hash, addressBalanceMap));

  // CRITICAL: Clear tx_proposal marks from inputs that were used in this voided transaction
  // This ensures the UTXOs can be used in new transactions after the void
  await withSpan('clearTxProposalForVoidedTx', () => clearTxProposalForVoidedTx(mysql, txInputs));

  /**
   * Delete ALL tokens created by this voided transaction.
   *
   * This handles all three token creation scenarios:
   *
   * 1. Pure CREATE_TOKEN_TX (no nano):
   *    - Deletes the single CREATE_TOKEN_TX token (token_id = tx_id)
   *
   * 2. Pure nano contract:
   *    - Deletes all tokens created by nano syscalls (token_id ≠ tx_id)
   *
   * 3. Hybrid (CREATE_TOKEN_TX + nano):
   *    - Deletes BOTH the CREATE_TOKEN_TX token AND all nano-created tokens
   *
   * Note: This is INDEPENDENT of nano execution state (nc_execution).
   * Even if nc_execution = 'success', we delete all tokens because the
   * ENTIRE transaction is being voided.
   *
   * See handleVertexAccepted for nano execution state change logic, which
   * ONLY deletes nano-created tokens when nc_execution becomes non-SUCCESS.
   */
  const tokensCreated = await getTokensCreatedByTx(mysql, hash);
  if (tokensCreated.length > 0) {
    logger.debug(`Voiding transaction ${hash} created ${tokensCreated.length} token(s), deleting them`);
    await deleteTokens(mysql, tokensCreated);
  }

  if (VALIDATE_ADDRESS_BALANCES) {
    const addresses = Object.keys(addressBalanceMap);
    await validateAddressBalances(mysql, addresses);
  }
};

export const handleVoidedTx = async (context: Context) => {
  return tracer.startActiveSpan('handleVoidedTx', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event as StandardFullNodeEvent;

        const {
          hash,
          outputs,
          inputs,
          shielded_outputs: shieldedOutputs = [],
          tokens,
          headers = [],
          version,
        } = fullNodeEvent.event.data;

        span.setAttribute('tx.hash', hash);
        logger.debug(`Will handle voided tx for ${hash}`);
        await voidTx(
          mysql,
          hash,
          inputs,
          outputs,
          shieldedOutputs,
          tokens,
          headers,
          version,
        );
        logger.debug(`Voided tx ${hash}`);
        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
        await mysql.commit();
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.debug(e);

        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

export const handleUnvoidedTx = async (context: Context) => {
  return tracer.startActiveSpan('handleUnvoidedTx', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event as StandardFullNodeEvent;

        const { hash } = fullNodeEvent.event.data;

        span.setAttribute('tx.hash', hash);
        logger.debug(`Tx ${hash} got unvoided, cleaning up the database.`);

        await cleanupVoidedTx(mysql, hash);

        logger.debug(`Unvoided tx ${hash}`);

        await mysql.commit();
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.debug(e);

        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

export const handleTxFirstBlock = async (context: Context) => {
  return tracer.startActiveSpan('handleTxFirstBlock', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event as StandardFullNodeEvent;

        const {
          hash,
          metadata,
          timestamp,
          version,
          weight,
        } = fullNodeEvent.event.data;

        span.setAttribute('tx.hash', hash);
        const firstBlock: string | null = metadata.first_block ?? null;
        // When first_block is null, height should also be null (tx back in mempool)
        const height: number | null = firstBlock ? metadata.height : null;

        await addOrUpdateTx(mysql, hash, height, timestamp, version, weight, firstBlock);
        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

        if (firstBlock) {
          logger.debug(`Confirmed tx ${hash} in block ${firstBlock}: ${fullNodeEvent.event.id}`);
        } else {
          logger.debug(`Tx ${hash} back to mempool (first_block=null): ${fullNodeEvent.event.id}`);
        }

        await mysql.commit();
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.error('E: ', e);
        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

/**
 * Handle NC_EXEC_VOIDED event - nc_execution changed from 'success' to something else.
 *
 * This happens during reorgs when a transaction goes back to mempool and nc_execution
 * changes from 'success' to 'pending' or null. When this occurs, any tokens created
 * by the nano contract execution are no longer valid.
 *
 * This handler deletes all nano-created tokens for the transaction. Traditional
 * CREATE_TOKEN_TX tokens (token_id = tx_id) are NOT affected — they remain valid
 * because the token creation is inherent to the transaction itself, not dependent
 * on nano contract execution.
 */
export const handleNcExecVoided = async (context: Context) => {
  return tracer.startActiveSpan('handleNcExecVoided', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event as StandardFullNodeEvent;
        const { hash } = fullNodeEvent.event.data;

        span.setAttribute('tx.hash', hash);

        // Get all tokens created by this transaction
        const tokensCreated = await getTokensCreatedByTx(mysql, hash);

        if (tokensCreated.length > 0) {
          // Filter out traditional CREATE_TOKEN_TX tokens (where token_id = tx_id)
          // These should NOT be deleted because they're inherent to the transaction
          const nanoTokens = tokensCreated.filter(tokenId => tokenId !== hash);

          if (nanoTokens.length > 0) {
            logger.debug(`NC execution voided for tx ${hash}, deleting ${nanoTokens.length} nano-created tokens`);
            await deleteTokens(mysql, nanoTokens);
          }
        }

        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
        await mysql.commit();
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.error('handleNcExecVoided error: ', e);
        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

export const updateLastSyncedEvent = async (context: Context) => {
  let mysql: PoolConnection | undefined;
  try {
    mysql = await getDbConnection();

    const lastDbSyncedEvent: LastSyncedEvent | null = await getLastSyncedEvent(mysql);

    if (!context.event) {
      throw new Error('Tried to update last synced event but no event in context');
    }

    const lastEventId = context.event.event.id;

    if (lastDbSyncedEvent
      && lastDbSyncedEvent.last_event_id > lastEventId) {
      logger.error('Tried to store an event lower than the one on the database', {
        lastEventId,
        lastDbSyncedEvent: JSONBigInt.stringify(lastDbSyncedEvent),
      });
      throw new Error('Event lower than stored one.');
    }
    await dbUpdateLastSyncedEvent(mysql, lastEventId);
  } finally {
    if (mysql) mysql.release();
  }
};

export const fetchMinRewardBlocks = async () => {
  const fullnodeUrl = getFullnodeHttpUrl();
  const response = await axios.get(`${fullnodeUrl}/version`);

  if (response.status !== 200) {
    throw new Error('Request to version API failed');
  }

  const rewardSpendMinBlocks = get(response, 'data.reward_spend_min_blocks');

  if (rewardSpendMinBlocks == null) {
    throw new Error('Failed to fetch reward spend min blocks');
  }

  return rewardSpendMinBlocks;
};

export const fetchInitialState = async () => {
  let mysql: PoolConnection | undefined;
  try {
    mysql = await getDbConnection();
    const lastEvent = await getLastSyncedEvent(mysql);
    const rewardMinBlocks = await fetchMinRewardBlocks();

    return {
      lastEventId: lastEvent?.last_event_id,
      rewardMinBlocks,
    };
  } finally {
    if (mysql) mysql.release();
  }
};

export const handleReorgStarted = async (context: Context): Promise<void> => {
  return tracer.startActiveSpan('handleReorgStarted', async (span) => {
    try {
      if (!context.event) {
        throw new Error('No event in context');
      }

      const fullNodeEvent = context.event;
      if (fullNodeEvent.event.type !== FullNodeEventTypes.REORG_STARTED) {
        throw new Error('Invalid event type for REORG_STARTED');
      }

      const { reorg_size, previous_best_block, new_best_block, common_block } = fullNodeEvent.event.data;

      span.setAttribute('reorg.size', reorg_size);
      const { REORG_SIZE_INFO, REORG_SIZE_MINOR, REORG_SIZE_MAJOR, REORG_SIZE_CRITICAL } = getConfig();

      const metadata = {
        reorg_size,
        previous_best_block,
        new_best_block,
        common_block,
      };

      if (reorg_size >= REORG_SIZE_CRITICAL) {
        await addAlert(
          'Critical Reorg Detected',
          `A critical reorg of size ${reorg_size} has occurred.`,
          Severity.CRITICAL,
          metadata,
          logger,
        );
      } else if (reorg_size >= REORG_SIZE_MAJOR) {
        await addAlert(
          'Major Reorg Detected',
          `A major reorg of size ${reorg_size} has occurred.`,
          Severity.MAJOR,
          metadata,
          logger,
        );
      } else if (reorg_size >= REORG_SIZE_MINOR) {
        await addAlert(
          'Minor Reorg Detected',
          `A minor reorg of size ${reorg_size} has occurred.`,
          Severity.MINOR,
          metadata,
          logger,
        );
      } else if (reorg_size >= REORG_SIZE_INFO) {
        await addAlert(
          'Reorg Detected',
          `A reorg of size ${reorg_size} has occurred.`,
          Severity.INFO,
          metadata,
          logger,
        );
      }
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
};

export const handleTokenCreated = async (context: Context) => {
  return tracer.startActiveSpan('handleTokenCreated', async (span) => {
    let mysql: PoolConnection | undefined;
    try {
      mysql = await getDbConnection();
      await mysql.beginTransaction();

      try {
        const fullNodeEvent = context.event;
        if (!fullNodeEvent) {
          throw new Error('No event in context');
        }

        if (fullNodeEvent.event.type !== FullNodeEventTypes.TOKEN_CREATED) {
          throw new Error('Invalid event type for TOKEN_CREATED');
        }

        const {
          token_uid,
          token_name,
          token_symbol,
          token_version,
          nc_exec_info,
        } = fullNodeEvent.event.data;

        span.setAttribute('token.uid', token_uid);

        logger.debug(`Handling TOKEN_CREATED event for token ${token_uid}: ${token_name} (${token_symbol}) v${token_version}`);

        // Store the mapping between token and the transaction that created it
        // For regular CREATE_TOKEN_TX: nc_exec_info is null, token_uid equals tx_id
        // For nano contract tokens: nc_exec_info.nc_tx contains the transaction hash
        const txId = nc_exec_info?.nc_tx ?? token_uid;
        const firstBlock = nc_exec_info?.nc_block ?? null;

        /**
         * Handle reorg scenario: first_block changed
         *
         * When a nano contract re-executes in a different block during a reorg,
         * the token_id might change even though tx_id stays the same.
         * Delete tokens with old first_block before inserting the new one.
         */
        const tokensWithOldBlock = await getReexecNanoTokens(mysql, txId, firstBlock);
        if (tokensWithOldBlock.length > 0) {
          logger.debug(`First block changed for tx ${txId}, deleting ${tokensWithOldBlock.length} tokens with old first_block`);
          await deleteTokens(mysql, tokensWithOldBlock);
        }

        // Check if this exact token already exists
        const existingToken = await getTokenInformation(mysql, token_uid);

        if (!existingToken) {
          // Insert the new token
          await storeTokenInformation(mysql, token_uid, token_name, token_symbol, token_version);
          await insertTokenCreation(mysql, token_uid, txId, firstBlock);

          logger.debug(`Inserted new token ${token_uid} with first_block=${firstBlock}, version=${token_version}`);
        } else {
          logger.debug(`Token ${token_uid} already exists, skipping insertion`);
        }

        await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

        await mysql.commit();
        logger.debug(`Successfully stored token ${token_uid} created by tx ${txId}`);
      } catch (e) {
        try {
          await mysql.rollback();
        } catch (rollbackErr) {
          // Rollback itself failed — the connection may still have an open
          // transaction. Destroy it and null out the handle so the outer
          // finally skips release(); otherwise the connection would go back
          // to the pool with a pending BEGIN and contaminate the next caller.
          logger.error('[ERROR] Rollback failed; destroying connection to avoid pool contamination', rollbackErr);
          try { mysql.destroy(); } catch { /* ignore */ }
          mysql = undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        span.recordException(e as Error);
        logger.error('Error handling TOKEN_CREATED event', e);
        throw e;
      }
    } finally {
      if (mysql) mysql.release();
      span.end();
    }
  });
};

/**
 * Checks the HTTP API for missed events after the last ACK
 * This is used to detect if we lost an event due to network packet loss
 */
export const checkForMissedEvents = async (context: Context): Promise<{ hasNewEvents: boolean; events: any[] }> => {
  const lastAckEventId = context.event?.event.id ?? context.initialEventId;

  if (lastAckEventId === null || lastAckEventId === undefined) {
    throw new Error('No event in context and no initialEventId when checking for missed events');
  }
  const fullnodeUrl = getFullnodeHttpUrl();

  logger.debug(`Checking for missed events after event ID ${lastAckEventId}`);

  let response;
  try {
    response = await retryWithBackoff(
      async () => {
        const res = await axios.get(`${fullnodeUrl}/event`, {
          params: {
            last_ack_event_id: lastAckEventId,
            size: 1,
          },
        });

        // Validate response status
        if (res.status !== 200) {
          logger.error(
            `Failed to check for missed events after ACK ${lastAckEventId}: HTTP ${res.status}. URL: ${fullnodeUrl}/event`
          );
          throw new Error(`Failed to check for missed events: HTTP ${res.status}`);
        }

        // Validate response structure
        if (!res.data || typeof res.data !== 'object') {
          logger.error(
            `Failed to check for missed events after ACK ${lastAckEventId}: Invalid response data structure. Response: ${JSONBigInt.stringify(res.data)}`
          );
          throw new Error('Failed to check for missed events: Invalid response structure');
        }

        return res;
      },
      {
        // It's possible that the fullnode is under high load or having intermittent issues,
        // so we use a higher number of retries to give it a chance to recover
        maxRetries: 10,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to check for missed events after ACK ${lastAckEventId}: Network error - ${errorMessage}. URL: ${fullnodeUrl}/event`
    );
    throw new Error(`Failed to check for missed events: Network error - ${errorMessage}`);
  }

  const { events } = response.data;
  const hasNewEvents = Array.isArray(events) && events.length > 0;

  if (hasNewEvents) {
    logger.warn(`Detected ${events.length} missed event(s) after ACK ${lastAckEventId}. Will reconnect.`);
  } else {
    logger.debug(`No missed events detected after ACK ${lastAckEventId}`);
  }

  return { hasNewEvents, events };
};
