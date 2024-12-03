/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// @ts-ignore
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
  FullNodeEvent,
  EventTxInput,
  EventTxOutput,
} from '../types';
import {
  TxInput,
  Transaction,
  TokenBalanceMap,
  TxOutputWithIndex,
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
  getLockedUtxoFromInputs,
  incrementTokensTxCount,
  getAddressWalletInfo,
  generateAddresses,
  addNewAddresses,
  updateWalletTablesWithTx,
  voidTransaction,
  updateLastSyncedEvent as dbUpdateLastSyncedEvent,
  getLastSyncedEvent,
  getTxOutputsFromTx,
  markUtxosAsVoided,
  cleanupVoidedTx,
  getMaxIndexAmongAddresses,
  getMaxWalletAddressIndex,
} from '../db';
import getConfig from '../config';
import logger from '../logger';
import { invokeOnTxPushNotificationRequestedLambda } from '../utils';

export const METADATA_DIFF_EVENT_TYPES = {
  IGNORE: 'IGNORE',
  TX_VOIDED: 'TX_VOIDED',
  TX_UNVOIDED: 'TX_UNVOIDED',
  TX_NEW: 'TX_NEW',
  TX_FIRST_BLOCK: 'TX_FIRST_BLOCK',
};

export const metadataDiff = async (_context: Context, event: Event) => {
  const mysql = await getDbConnection();

  try {
    const fullNodeEvent = event.event as FullNodeEvent;
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

export const handleVertexAccepted = async (context: Context, _event: Event) => {
  console.time('handleVertexAccepted');
  const mysql = await getDbConnection();
  await mysql.beginTransaction();
  logger.info('Handling vertex accepted.');

  try {
    const fullNodeEvent = context.event as FullNodeEvent;
    const now = getUnixTimestamp();
    const { PUSH_NOTIFICATION_ENABLED } = getConfig();
    const blockRewardLock = context.rewardMinBlocks;

    if (!blockRewardLock) {
      throw new Error('No block reward lock set');
    }

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
    } = fullNodeEvent.event.data;

    logger.info('Will get tx by id');
    console.time('tx by id');
    const dbTx: DbTransaction | null = await getTransactionById(mysql, hash);
    console.timeEnd('tx by id');
    logger.info('done.');

    if (dbTx) {
      logger.error(`Transaction ${hash} already in the database, this should only happen if the service has been recently restarted`);

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

    let heightlock = null;
    if (isBlock(version)) {
      if (typeof height !== 'number' && !height) {
        throw new Error('Block with no height set in metadata.');
      }

      // unlock older blocks
      logger.info('Will get utxos locked at height');
      console.time('getUtxosLockedAtHeight');
      const utxos = await getUtxosLockedAtHeight(mysql, now, height);
      console.timeEnd('getUtxosLockedAtHeight');
      logger.info('got utxos locked at height');

      if (utxos.length > 0) {
        logger.debug(`Block transaction, unlocking ${utxos.length} locked utxos at height ${height}`);
        console.time('unlockUtxos');
        await unlockUtxos(mysql, utxos, false);
        console.timeEnd('unlockUtxos');
      }

      // set heightlock
      heightlock = height + blockRewardLock;

      // get the first output address
      const blockRewardOutput = outputs[0];

      // add miner to the miners table
      if (blockRewardOutput.decoded) {
        console.time('addMiner');
        await addMiner(mysql, blockRewardOutput.decoded.address, hash);
        console.timeEnd('addMiner');
      }

      // here we check if we have any utxos on our database that is locked but
      // has its timelock < now
      //
      // we've decided to do this here considering that it is acceptable to have
      // a delay between the actual timelock expiration time and the next block
      // (that will unlock it). This delay is only perceived on the wallet as the
      // sync mechanism will unlock the timelocked utxos as soon as they are seen
      // on a received transaction.
      console.time('unlockTimelockedUtxos');
      await unlockTimelockedUtxos(mysql, now);
      console.timeEnd('unlockTimelockedUtxos');
    }

    if (version === hathorLib.constants.CREATE_TOKEN_TX_VERSION) {
      if (!token_name || !token_symbol) {
        throw new Error('Processed a token creation event but it did not come with token name and symbol');
      }
      console.time('storeTokenInformation');
      await storeTokenInformation(mysql, hash, token_name, token_symbol);
      console.timeEnd('storeTokenInformation');
    }

    // check if any of the inputs are still marked as locked and update tables accordingly.
    // See remarks on getLockedUtxoFromInputs for more explanation. It's important to perform this
    // before updating the balances
    const lockedInputs = await getLockedUtxoFromInputs(mysql, inputs);
    console.time('unlockUtxos');
    await unlockUtxos(mysql, lockedInputs, true);
    console.timeEnd('unlockUtxos');

    // add transaction outputs to the tx_outputs table
    markLockedOutputs(txOutputs, now, heightlock !== null);

    // Add the transaction
    logger.debug('Will add the tx with height', height);
    console.time('addOrUpdateTx');
    await addOrUpdateTx(
      mysql,
      hash,
      height,
      timestamp,
      version,
      weight,
    );
    console.timeEnd('addOrUpdateTx');

    // Add utxos
    console.time('addUtxos');
    await addUtxos(mysql, hash, txOutputs, heightlock);
    console.timeEnd('addUtxos');
    console.time('updateTxOutputSpentBy');
    await updateTxOutputSpentBy(mysql, txInputs, hash);
    console.timeEnd('updateTxOutputSpentBy');

    // Genesis tx has no inputs and outputs, so nothing to be updated, avoid it
    if (inputs.length > 0 || outputs.length > 0) {
      const tokenList: string[] = getTokenListFromInputsAndOutputs(txInputs, txOutputs);

      // Update transaction count with the new tx
      console.time('incrementTokensTxCount');
      await incrementTokensTxCount(mysql, tokenList);
      console.timeEnd('incrementTokensTxCount');

      const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputs);

      // update address tables (address, address_balance, address_tx_history)
      console.time('updateAddressTablesWithTx');
      await updateAddressTablesWithTx(mysql, hash, timestamp, addressBalanceMap);
      console.timeEnd('updateAddressTablesWithTx');

      // for the addresses present on the tx, check if there are any wallets associated
      const addressWalletMap: StringMap<Wallet> = await getAddressWalletInfo(mysql, Object.keys(addressBalanceMap));
      console.log('address wallet map: ', addressWalletMap);

      const seenWallets = new Set();
      const addressesPerWallet = Object.entries(addressWalletMap).reduce(
        (result: StringMap<{ addresses: string[], walletDetails: Wallet }>, [address, wallet]: [string, Wallet]) => {
        const { walletId } = wallet;

        seenWallets.add(walletId);

        // Initialize the array if the walletId is not yet a key in result
        if (!result[walletId]) {
          result[walletId] = {
            addresses: [],
            walletDetails: wallet,
          }
        }

        // Add the current key to the array
        result[walletId].addresses.push(address);
        result[walletId].walletDetails = wallet;

        return result;
      }, {});

      for (const [walletId, data] of Object.entries(addressesPerWallet)) {
        const { addresses, walletDetails } = data;
        const maxIndexAmongAddresses = await getMaxIndexAmongAddresses(mysql, walletId, addresses);
        const maxWalletAddressIndex = await getMaxWalletAddressIndex(mysql, walletId);

        if (!maxIndexAmongAddresses || !maxWalletAddressIndex) {
          // Do nothing, this is unexpected and an error should have been logged already.
          continue;
        }

        const diff = maxWalletAddressIndex - maxIndexAmongAddresses;

        if (diff < walletDetails.maxGap) {
          // We need to generate addresses.
          const addresses = await generateAddresses(walletDetails.xpubkey, maxWalletAddressIndex + 1, walletDetails.maxGap);
          // might need to generate new addresses to keep maxGap
          await addNewAddresses(mysql, walletId, addresses, maxIndexAmongAddresses);
        }
      }

      // update wallet_balance and wallet_tx_history tables
      const walletBalanceMap: StringMap<TokenBalanceMap> = getWalletBalanceMap(addressWalletMap, addressBalanceMap);
      await updateWalletTablesWithTx(mysql, hash, timestamp, walletBalanceMap);

      const tx: Transaction = {
        tx_id: hash,
        nonce,
        timestamp,
        voided: metadata.voided_by.length > 0,
        weight,
        parents,
        version,
        inputs: txInputs,
        outputs: txOutputs,
        height: metadata.height,
        token_name,
        token_symbol,
        signal_bits: 0, // TODO: we should actually receive this and store in the database
      };

      /* try {
        if (seenWallets.size > 0) {
          const queueUrl = NEW_TX_SQS;
          if (!queueUrl) {
            throw new Error('Queue URL is invalid');
          }

          await sendMessageSQS(JSON.stringify({
            wallets: Array.from(seenWallets),
            tx,
          }), queueUrl);
        }
      } catch (e) {
        logger.error('Failed to send transaction to SQS queue');
        logger.error(e);
      } */

      try {
        if (PUSH_NOTIFICATION_ENABLED) {
          const walletBalanceMap = await getWalletBalancesForTx(mysql, tx);
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

      const {
        NETWORK,
        STAGE,
      } = getConfig();

      const network = new hathorLib.Network(NETWORK);

      // Validating for NFTs only after the tx is successfully added
      if (NftUtils.shouldInvokeNftHandlerForTx(tx, network, logger)) {
        // This process is not critical, so we run it in a fire-and-forget manner, not waiting for the promise.
        // In case of errors, just log the asynchronous exception and take no action on it.
        NftUtils.invokeNftHandlerLambda(tx.tx_id, STAGE, logger)
          .catch((err: unknown) => logger.error('[ALERT] Error on nftHandlerLambda invocation', err));
      }
    }

    await dbUpdateLastSyncedEvent(mysql, fullNodeEvent.event.id);

    await mysql.commit();
  } catch (e) {
    await mysql.rollback();
    logger.error(e);

    throw e;
  } finally {
    console.timeEnd('handleVertexAccepted');
    mysql.destroy();
  }
};

export const handleVertexRemoved = async (context: Context, _event: Event) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();

  try {
    const fullNodeEvent = context.event as FullNodeEvent;

    const {
      hash,
      outputs,
      inputs,
      tokens,
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

export const voidTx = async (
  mysql: MysqlConnection,
  hash: string,
  inputs: EventTxInput[],
  outputs: EventTxOutput[],
  tokens: string[],
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

  const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputsWithLocked);
  await voidTransaction(mysql, hash, addressBalanceMap);
  await markUtxosAsVoided(mysql, dbTxOutputs);

  const addresses = Object.keys(addressBalanceMap);
  await validateAddressBalances(mysql, addresses);
};

export const handleVoidedTx = async (context: Context) => {
  const mysql = await getDbConnection();
  await mysql.beginTransaction();

  try {
    const fullNodeEvent = context.event as FullNodeEvent;

    const {
      hash,
      outputs,
      inputs,
      tokens,
    } = fullNodeEvent.event.data;

    logger.debug(`Will handle voided tx for ${hash}`);
    await voidTx(
      mysql,
      hash,
      inputs,
      outputs,
      tokens
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
    const fullNodeEvent = context.event as FullNodeEvent;

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
    const fullNodeEvent = context.event as FullNodeEvent;

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
       lastDbSyncedEvent: JSON.stringify(lastDbSyncedEvent),
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
