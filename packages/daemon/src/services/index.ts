/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import hathorLib from '@hathor/wallet-lib';
import { Connection as MysqlConnection } from 'mysql2/promise';
import axios from 'axios';
import { get } from 'lodash';
import { NftUtils } from '@wallet-service/common';
import {
  StringMap,
  Wallet,
  DbTxOutput,
  DbTransaction,
  LastSyncedEvent,
  Event,
  Context,
  EventTxInput,
  EventTxOutput,
  WalletStatus,
  FullNodeEventTypes,
  StandardFullNodeEvent,
  EventTxHeader,
  isNanoHeader,
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
  getAddressBalanceMap,
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
  insertTokenCreation,
  getTokensCreatedByTx,
  deleteTokenCreationMappings,
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
  getTxOutput,
  clearTxProposalForVoidedTx,
} from '../db';
import getConfig from '../config';
import logger from '../logger';
import { invokeOnTxPushNotificationRequestedLambda, getDaemonUptime, retryWithBackoff } from '../utils';
import { addAlert, Severity } from '@wallet-service/common';
import { JSONBigInt } from '@hathor/wallet-lib/lib/utils/bigint';

export const METADATA_DIFF_EVENT_TYPES = {
  IGNORE: 'IGNORE',
  TX_VOIDED: 'TX_VOIDED',
  TX_UNVOIDED: 'TX_UNVOIDED',
  TX_NEW: 'TX_NEW',
  TX_FIRST_BLOCK: 'TX_FIRST_BLOCK',
};

const DUPLICATE_TX_ALERT_GRACE_PERIOD = 10; // seconds

export const metadataDiff = async (_context: Context, event: Event) => {
  const mysql = await getDbConnection();

  try {
    const fullNodeEvent = event.event as StandardFullNodeEvent;
    const {
      hash,
      metadata: { voided_by, first_block },
    } = fullNodeEvent.event.data;
    const dbTx: DbTransaction | null = await getTransactionById(mysql, hash);

    if (!dbTx) {
      if (voided_by.length > 0) {
        // No need to add voided transactions
        return {
          type: METADATA_DIFF_EVENT_TYPES.IGNORE,
          originalEvent: event,
        };
      }

      return {
        type: METADATA_DIFF_EVENT_TYPES.TX_NEW,
        originalEvent: event,
      };
    }

    // Tx is voided
    if (voided_by.length > 0) {
      // Was it voided on the database?
      if (!dbTx.voided) {
        return {
          type: METADATA_DIFF_EVENT_TYPES.TX_VOIDED,
          originalEvent: event,
        };
      }

      return {
        type: METADATA_DIFF_EVENT_TYPES.IGNORE,
        originalEvent: event,
      };
    }

    // Tx was voided in the database but is not anymore
    if (dbTx.voided && voided_by.length <= 0) {
      return {
        type: METADATA_DIFF_EVENT_TYPES.TX_UNVOIDED,
        originalEvent: event,
      };
    }

    if (first_block
      && first_block.length
      && first_block.length > 0) {
      if (!dbTx.height) {
        return {
          type: METADATA_DIFF_EVENT_TYPES.TX_FIRST_BLOCK,
          originalEvent: event,
        };
      }

      return {
        type: METADATA_DIFF_EVENT_TYPES.IGNORE,
        originalEvent: event,
      };
    }

    return {
      type: METADATA_DIFF_EVENT_TYPES.IGNORE,
      originalEvent: event,
    };
  } catch (e) {
    logger.error('e', e);
    return Promise.reject(e);
  } finally {
    mysql.destroy();
  }
};

export const isBlock = (version: number): boolean => version === hathorLib.constants.BLOCK_VERSION
  || version === hathorLib.constants.MERGED_MINED_BLOCK_VERSION;

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
 *    - Token deletion rule: Delete when nc_execution changes from SUCCESS to any non-SUCCESS state
 *      (PENDING, FAILURE, SKIPPED, or null)
 *    - This happens during reorgs when the nano execution is invalidated
 *    - Token can be re-created if nano executes successfully again after reorg
 *
 * 3. **Hybrid Transaction (CREATE_TOKEN_TX + Nano Contract)**
 *    - Creates TWO sets of tokens:
 *      a) CREATE_TOKEN_TX token: Received immediately when tx hits mempool (token_id = tx_id)
 *      b) Nano-created tokens: Received when nano executes successfully (token_id ≠ tx_id)
 *    - Token deletion rules:
 *      - CREATE_TOKEN_TX token: Delete ONLY when transaction becomes voided
 *      - Nano-created tokens: Delete when nc_execution becomes non-SUCCESS
 *    - During reorg: Only nano-created tokens are deleted, CREATE_TOKEN_TX token remains
 *    - When voided: BOTH sets of tokens are deleted
 *
 * Important Notes:
 * - Voided and nc_execution are INDEPENDENT conditions
 * - A voided transaction might still show nc_execution = 'success'
 * - INSERT IGNORE ensures idempotency when tokens are re-created after reorg
 * - Token deletion happens before storing the transaction to maintain consistency
 *
 * @param context - The context containing the event and other metadata
 * @param _event - The event being processed (unused, context.event is used instead)
 */
export const handleVertexAccepted = async (context: Context, _event: Event) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();
  const {
    NETWORK,
    STAGE,
    SERVERLESS_DEPLOY_PREFIX,
    PUSH_NOTIFICATION_ENABLED,
  } = getConfig();

  try {
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

    const isNano = isNanoContract(headers);

    const dbTx: DbTransaction | null = await getTransactionById(mysql, hash);

    if (dbTx) {
      const daemonUptime = getDaemonUptime();
      // We do not log if the daemon has just started, because it's expected that
      // we receive an initial duplicate transaction from the fullnode in this case.
      if (daemonUptime < DUPLICATE_TX_ALERT_GRACE_PERIOD) return;

      logger.error(`Transaction ${hash} already in the database and the daemon has not been recently restarted (uptime of ${daemonUptime} seconds). This is unexpected.`);

      // This might happen if the service has been recently restarted,
      // so we should raise the alert and just ignore the tx
      return;
    }

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

      // get the first output address
      const blockRewardOutput = outputs[0];

      // add miner to the miners table
      if (isDecodedValid(blockRewardOutput.decoded, ['address'])) {
        await addMiner(mysql, blockRewardOutput.decoded!.address, hash);
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

    // check if any of the inputs are still marked as locked and update tables accordingly.
    // See remarks on getLockedUtxoFromInputs for more explanation. It's important to perform this
    // before updating the balances
    const lockedInputs = await getLockedUtxoFromInputs(mysql, inputs);
    await unlockUtxos(mysql, lockedInputs, true);

    // add transaction outputs to the tx_outputs table
    markLockedOutputs(txOutputs, now, heightlock !== null);

    // Add the transaction
    logger.debug('Will add the tx with height', height);
    // TODO: add is_nanocontract to transaction table?
    await addOrUpdateTx(
      mysql,
      hash,
      height,
      timestamp,
      version,
      weight,
    );

    // Add utxos
    await addUtxos(mysql, hash, txOutputs, heightlock);

    // Mark tx utxos as spent
    await updateTxOutputSpentBy(mysql, txInputs, hash);

    // Genesis tx has no inputs and outputs, so nothing to be updated, avoid it
    // Nano contracts are a special case since they can have an address to update even without inputs/outputs
    if (inputs.length > 0 || outputs.length > 0 || isNano) {
      const tokenList: string[] = getTokenListFromInputsAndOutputs(txInputs, txOutputs);

      // Update transaction count with the new tx
      await incrementTokensTxCount(mysql, tokenList);

      const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputs, headers);

      // update address tables (address, address_balance, address_tx_history)
      await updateAddressTablesWithTx(mysql, hash, timestamp, addressBalanceMap);

      // for the addresses present on the tx, check if there are any wallets associated
      const addressWalletMap: StringMap<Wallet> = await getAddressWalletInfo(mysql, Object.keys(addressBalanceMap));

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

        const { maxAmongAddresses, maxWalletIndex } = indices;

        if (!maxAmongAddresses || !maxWalletIndex) {
          // Do nothing, wallet is most likely not loaded yet.
          if (walletDetails.status === WalletStatus.READY) {
            logger.error('[ERROR] A wallet marked as READY does not have a max wallet index or address index was not found in the database');
          }
          continue;
        }

        const diff = maxWalletIndex - maxAmongAddresses;

        if (diff < walletDetails.maxGap) {
          // We need to generate addresses
          const addresses = await generateAddresses(NETWORK as string, walletDetails.xpubkey, maxWalletIndex + 1, walletDetails.maxGap - diff);
          await addNewAddresses(mysql, walletId, addresses, maxAmongAddresses);
        }
      }

      // update wallet_balance and wallet_tx_history tables
      const walletBalanceMap: StringMap<TokenBalanceMap> = getWalletBalanceMap(addressWalletMap, addressBalanceMap);
      await updateWalletTablesWithTx(mysql, hash, timestamp, walletBalanceMap);

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
        headers,
        height: metadata.height,
        token_name,
        token_symbol,
        signal_bits: 0, // TODO: we should actually receive this and store in the database
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
          const walletBalanceMap = await getWalletBalancesForTx(mysql, txData);
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

      const network = new hathorLib.Network(NETWORK);

      // Call to process the data for NFT handling (if applicable)
      // This process is not critical, so we run it in a fire-and-forget manner, not waiting for the promise.
      NftUtils.processNftEvent(fullNodeData, STAGE, SERVERLESS_DEPLOY_PREFIX, network, logger)
        .catch((err: unknown) => logger.error('[ALERT] Error processing NFT event', err));
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

    /**
     * Nano Contract Token Deletion Logic
     *
     * Handle token deletion when nano contract execution state changes.
     *
     * Context:
     * - Nano contracts can create tokens via syscalls when they execute successfully
     * - These tokens are only valid when nc_execution = 'success'
     * - During reorgs, nano execution can be invalidated (nc_execution becomes PENDING/FAILURE/SKIPPED/null)
     * - When this happens, any tokens created by that nano execution must be deleted
     *
     * Why this is needed:
     * - A transaction with nano headers can create tokens in TWO ways:
     *   1. Via CREATE_TOKEN_TX (token_id = tx_id) - deleted only on void
     *   2. Via nano syscall (token_id ≠ tx_id) - deleted when nc_execution becomes non-SUCCESS
     *
     * Edge case: Hybrid transactions
     * - A hybrid transaction (CREATE_TOKEN_TX + nano headers) creates BOTH types of tokens
     * - During reorg: We must delete ONLY the nano-created tokens, NOT the CREATE_TOKEN_TX token
     * - The getTokensCreatedByTx query returns ALL tokens created by this tx_id
     * - However, in practice:
     *   - Pure nano contracts: All tokens in the result are nano-created (safe to delete all)
     *   - Hybrid transactions: Both CREATE_TOKEN_TX and nano-created tokens are in the result
     *     BUT the CREATE_TOKEN_TX token was already deleted by a previous VERTEX_METADATA_CHANGED
     *     event that voided the transaction, so it won't be in the database anymore
     *
     * Flow example (hybrid transaction during reorg):
     * 1. CREATE_TOKEN_TX arrives → TOKEN_CREATED event (CREATE_TOKEN_TX token stored)
     * 2. Tx gets first_block → nano executes → TOKEN_CREATED event (nano token stored)
     * 3. VERTEX_METADATA_CHANGED → nc_execution: SUCCESS (both tokens in DB)
     * 4. REORG → VERTEX_METADATA_CHANGED → nc_execution: PENDING, first_block: null
     *    → This code runs → Deletes nano token, CREATE_TOKEN_TX token remains
     * 5. Tx executes again → TOKEN_CREATED → nano token re-created (INSERT IGNORE handles duplicates)
     *
     * Note: This logic is INDEPENDENT of transaction voiding:
     * - Voiding deletes ALL tokens (handled by voidTx function)
     * - This logic deletes ONLY nano-created tokens when execution state changes
     * - A voided transaction might still have nc_execution = 'success'
     */
    const hasNanoHeaders = headers && headers.length > 0 && headers.some((h) => isNanoHeader(h));

    if (hasNanoHeaders) {
      const ncExecution = metadata?.nc_execution;

      // If nc_execution is not 'success', delete any tokens created by this nano contract
      if (ncExecution !== 'success') {
        const tokensCreated = await getTokensCreatedByTx(mysql, hash);

        if (tokensCreated.length > 0) {
          logger.debug(`NC execution changed to ${ncExecution}, deleting ${tokensCreated.length} tokens created by tx ${hash}`);
          await deleteTokens(mysql, tokensCreated);
          await deleteTokenCreationMappings(mysql, tokensCreated);
        }
      }
    }

    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

    await mysql.commit();
  } catch (e) {
    await mysql.rollback();
    console.error('Error handling vertex accepted', {
      error: (e as Error).message,
      stack: (e as Error).stack,
    });

    throw e;
  } finally {
    mysql.destroy();
  }
};

export const handleVertexRemoved = async (context: Context, _event: Event) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();

  try {
    const fullNodeEvent = context.event as StandardFullNodeEvent;

    const {
      hash,
      outputs,
      inputs,
      tokens,
      headers = [],
      version,
    } = fullNodeEvent.event.data;

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
      tokens,
      headers,
      version,
    );

    logger.info(`[VertexRemoved] Removing tx from database: ${hash}`);
    await cleanupVoidedTx(mysql, hash);
    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
    await mysql.commit();
  } catch (e) {
    logger.debug(e);
    await mysql.rollback();

    throw e;
  } finally {
    mysql.destroy();
  }
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
  tokens: string[],
  headers: EventTxHeader[],
  version: number,
) => {
  const dbTxOutputs: DbTxOutput[] = await getTxOutputsFromTx(mysql, hash);
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

  const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputsWithLocked, headers);

  await voidTransaction(mysql, hash);
  // CRITICAL: markUtxosAsVoided must be called before voidAddressTransaction
  // and voidWalletTransaction as those methods recalculate balances based on
  // the UTXOs table.
  await markUtxosAsVoided(mysql, dbTxOutputs);
  await voidAddressTransaction(mysql, hash, addressBalanceMap, version);

  // CRITICAL: Unspend the inputs when voiding a transaction
  // The inputs of the voided transaction need to be marked as unspent
  // But only if they were actually spent by this transaction
  if (inputs.length > 0) {
    // First, check which inputs were actually spent by this transaction
    const inputsSpentByThisTx: DbTxOutput[] = [];

    for (const input of inputs) {
      // Get the current state of this output to check if it's spent by our transaction
      const currentOutput = await getTxOutput(mysql, input.tx_id, input.index, false);


      if (currentOutput && currentOutput.spentBy === hash) {
        inputsSpentByThisTx.push({
          txId: input.tx_id,
          index: input.index,
          tokenId: '', // Not needed for unspending
          address: '', // Not needed for unspending
          value: BigInt(0), // Not needed for unspending
          authorities: 0, // Not needed for unspending
          timelock: null, // Not needed for unspending
          heightlock: null, // Not needed for unspending
          locked: false, // Not needed for unspending
          spentBy: hash, // This is what we're unsetting
          voided: false, // Not needed for unspending
        });
      }
    }

    if (inputsSpentByThisTx.length > 0) {
      await unspendUtxos(mysql, inputsSpentByThisTx);
    }
  }

  // CRITICAL: Update wallet balances when voiding a transaction
  await voidWalletTransaction(mysql, hash, addressBalanceMap);

  // CRITICAL: Clear tx_proposal marks from inputs that were used in this voided transaction
  // This ensures the UTXOs can be used in new transactions after the void
  await clearTxProposalForVoidedTx(mysql, txInputs);

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
    await deleteTokenCreationMappings(mysql, tokensCreated);
  }

  const addresses = Object.keys(addressBalanceMap);
  await validateAddressBalances(mysql, addresses);
};

export const handleVoidedTx = async (context: Context) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();

  try {
    const fullNodeEvent = context.event as StandardFullNodeEvent;

    const {
      hash,
      outputs,
      inputs,
      tokens,
      headers = [],
      version,
    } = fullNodeEvent.event.data;

    logger.debug(`Will handle voided tx for ${hash}`);
    await voidTx(
      mysql,
      hash,
      inputs,
      outputs,
      tokens,
      headers,
      version,
    );
    logger.debug(`Voided tx ${hash}`);
    await mysql.commit();
    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
  } catch (e) {
    logger.debug(e);
    await mysql.rollback();

    throw e;
  } finally {
    mysql.destroy();
  }
};

export const handleUnvoidedTx = async (context: Context) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();

  try {
    const fullNodeEvent = context.event as StandardFullNodeEvent;

    const { hash } = fullNodeEvent.event.data;

    logger.debug(`Tx ${hash} got unvoided, cleaning up the database.`);

    await cleanupVoidedTx(mysql, hash);

    logger.debug(`Unvoided tx ${hash}`);

    await mysql.commit();
  } catch (e) {
    logger.debug(e);
    await mysql.rollback();

    throw e;
  } finally {
    mysql.destroy();
  }
};

export const handleTxFirstBlock = async (context: Context) => {
  const mysql = await getDbConnection();
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

    const height: number | null = metadata.height;

    if (!metadata.first_block) {
      throw new Error('HandleTxFirstBlock called but no first block on metadata');
    }

    await addOrUpdateTx(mysql, hash, height, timestamp, version, weight);
    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);
    logger.debug(`Confirmed tx ${hash}: ${fullNodeEvent.event.id}`);

    await mysql.commit();
  } catch (e) {
    logger.error('E: ', e);
    await mysql.rollback();
    throw e;
  } finally {
    mysql.destroy();
  }
};

export const updateLastSyncedEvent = async (context: Context) => {
  const mysql = await getDbConnection();

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
    mysql.destroy();
    throw new Error('Event lower than stored one.');
  }
  await dbUpdateLastSyncedEvent(mysql, lastEventId);

  mysql.destroy();
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
  const mysql = await getDbConnection();
  const lastEvent = await getLastSyncedEvent(mysql);
  const rewardMinBlocks = await fetchMinRewardBlocks();

  mysql.destroy();

  return {
    lastEventId: lastEvent?.last_event_id,
    rewardMinBlocks,
  };
};

export const handleReorgStarted = async (context: Context): Promise<void> => {
  if (!context.event) {
    throw new Error('No event in context');
  }

  const fullNodeEvent = context.event;
  if (fullNodeEvent.event.type !== FullNodeEventTypes.REORG_STARTED) {
    throw new Error('Invalid event type for REORG_STARTED');
  }

  const { reorg_size, previous_best_block, new_best_block, common_block } = fullNodeEvent.event.data;
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
};

export const handleTokenCreated = async (context: Context) => {
  const mysql = await getDbConnection();
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
      nc_exec_info,
    } = fullNodeEvent.event.data;

    logger.debug(`Handling TOKEN_CREATED event for token ${token_uid}: ${token_name} (${token_symbol})`);

    // Store the token information
    await storeTokenInformation(mysql, token_uid, token_name, token_symbol);

    // Store the mapping between token and the transaction that created it
    // For regular CREATE_TOKEN_TX: nc_exec_info is null, token_uid equals tx_id
    // For nano contract tokens: nc_exec_info.nc_tx contains the transaction hash
    const txId = nc_exec_info?.nc_tx ?? token_uid;

    await insertTokenCreation(mysql, token_uid, txId);

    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

    await mysql.commit();
    logger.debug(`Successfully stored token ${token_uid} created by tx ${txId}`);
  } catch (e) {
    logger.error('Error handling TOKEN_CREATED event', e);
    await mysql.rollback();
    throw e;
  } finally {
    mysql.destroy();
  }
};

/**
 * Checks the HTTP API for missed events after the last ACK
 * This is used to detect if we lost an event due to network packet loss
 */
export const checkForMissedEvents = async (context: Context): Promise<{ hasNewEvents: boolean; events: any[] }> => {
  if (!context.event) {
    throw new Error('No event in context when checking for missed events');
  }

  const lastAckEventId = context.event.event.id;
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
