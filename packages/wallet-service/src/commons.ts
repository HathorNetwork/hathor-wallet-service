/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyHandler } from 'aws-lambda';

import { ServerlessMysql } from 'serverless-mysql';
import { strict as assert } from 'assert';

import {
  getAddressWalletInfo,
  getLatestHeight,
  getWalletBalances as dbGetWalletBalances,
  getWalletUnlockedUtxos,
  getExpiredTimelocksUtxos,
  unlockUtxos as dbUnlockUtxos,
  updateAddressLockedBalance,
  updateWalletLockedBalance,
  getBlockByHeight,
  getTxsAfterHeight,
  markTxsAsVoided,
  getTxOutputs,
  getTxOutputsBySpent,
  removeTxsHeight,
  unspendUtxos,
  markUtxosAsVoided,
  getTransactionsById,
  deleteBlocksAfterHeight,
  markWalletTxHistoryAsVoided,
  markAddressTxHistoryAsVoided,
  rebuildAddressBalancesFromUtxos,
  fetchAddressBalance,
  fetchAddressTxHistorySum,
  getTokenSymbols,
} from '@src/db';
import {
  StringMap,
  TokenBalanceMap,
  TxOutputWithIndex,
  DbTxOutput,
  Tx,
  Wallet,
  Block,
  WalletTokenBalance,
  AddressBalance,
  AddressTotalBalance,
  WalletProxyHandler,
  WalletBalance,
  WalletBalanceValue,
} from '@src/types';
import { Logger } from 'winston';
import {
  DecodedOutput,
  TxInput,
  TxOutput,
  Transaction,
  Severity,
} from '@wallet-service/common/src/types';
import { addAlert } from '@wallet-service/common/src/utils/alerting.utils';

import { isTxVoided } from '@src/utils';

import hathorLib from '@hathor/wallet-lib';
import { stringMapIterator, WalletBalanceMapConverter } from '@src/db/utils';
import config from '@src/config';

const WARN_MAX_REORG_SIZE = config.warnMaxReorgSize;

/**
 * Update the unlocked/locked balances for addresses and wallets connected to the given UTXOs.
 *
 * @param mysql - Database connection
 * @param utxos - List of UTXOs that are unlocked by height
 * @param updateTimelocks - If this update is triggered by a timelock expiring, update the next lock expiration
 */
export const unlockUtxos = async (mysql: ServerlessMysql, utxos: DbTxOutput[], updateTimelocks: boolean): Promise<void> => {
  if (utxos.length === 0) return;

  const outputs: TxOutput[] = utxos.map((utxo) => {
    const decoded: DecodedOutput = {
      type: 'P2PKH',
      address: utxo.address,
      timelock: utxo.timelock,
    };

    return {
      value: utxo.authorities > 0 ? BigInt(utxo.authorities) : utxo.value,
      token: utxo.tokenId,
      decoded,
      locked: false,
      // set authority bit if necessary
      token_data: utxo.authorities > 0 ? hathorLib.constants.TOKEN_AUTHORITY_MASK : 0,
      // we don't care about spent_by and script
      spent_by: null,
      script: '',
    };
  });

  // mark as unlocked in database (this just changes the 'locked' flag)
  await dbUnlockUtxos(mysql, utxos);

  const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap([], outputs);
  // update address_balance table
  await updateAddressLockedBalance(mysql, addressBalanceMap, updateTimelocks);

  // check if addresses belong to any started wallet
  const addressWalletMap: StringMap<Wallet> = await getAddressWalletInfo(mysql, Object.keys(addressBalanceMap));

  // update wallet_balance table
  const walletBalanceMap: StringMap<TokenBalanceMap> = getWalletBalanceMap(addressWalletMap, addressBalanceMap);
  await updateWalletLockedBalance(mysql, walletBalanceMap, updateTimelocks);
};

/**
 * Update the unlocked/locked balances for addresses and wallets connected to the UTXOs that were unlocked
 * because of their timelocks expiring
 *
 * @param mysql - Database connection
 * @param now - Current timestamp
 */
export const unlockTimelockedUtxos = async (mysql: ServerlessMysql, now: number): Promise<void> => {
  const utxos: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, now);

  await unlockUtxos(mysql, utxos, true);
};

/**
 * Mark a transaction's outputs that are locked. Modifies the outputs in place.
 *
 * @remarks
 * The timestamp is used to determine if each output is locked by time. On the other hand, `hasHeightLock`
 * applies to all outputs.
 *
 * The idea is that `hasHeightLock = true` should be used for blocks, whose outputs are locked by
 * height. Timelocks are handled by the `now` parameter.
 *
 * @param outputs - The transaction outputs
 * @param now - Current timestamp
 * @param hasHeightLock - Flag that tells if outputs are locked by height
 */
export const markLockedOutputs = (outputs: TxOutputWithIndex[], now: number, hasHeightLock = false): void => {
  for (const output of outputs) {
    output.locked = false;
    if (hasHeightLock || output.decoded.timelock > now) {
      output.locked = true;
    }
  }
};

/**
 * Get the map of token balances for each address in the transaction inputs and outputs.
 *
 * @example
 * Return map has this format:
 * ```
 * {
 *   address1: {token1: balance1, token2: balance2},
 *   address2: {token1: balance3}
 * }
 * ```
 *
 * @param inputs - The transaction inputs
 * @param outputs - The transaction outputs
 * @returns A map of addresses and its token balances
 */
export const getAddressBalanceMap = (
  inputs: TxInput[],
  outputs: TxOutput[],
): StringMap<TokenBalanceMap> => {
  const addressBalanceMap = {};

  for (const input of inputs) {
    const address = input.decoded.address;

    // get the TokenBalanceMap from this input
    const tokenBalanceMap = TokenBalanceMap.fromTxInput(input);
    // merge it with existing TokenBalanceMap for the address
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  for (const output of outputs) {
    const address = output.decoded.address;

    // get the TokenBalanceMap from this output
    const tokenBalanceMap = TokenBalanceMap.fromTxOutput(output);

    // merge it with existing TokenBalanceMap for the address
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  return addressBalanceMap;
};

/**
 * Gets a list of tokens from a list of inputs and outputs
 *
 * @param inputs - The transaction inputs
 * @param outputs - The transaction outputs
 * @returns A list of tokens present in the inputs and outputs
 */
export const getTokenListFromInputsAndOutputs = (inputs: TxInput[], outputs: TxOutputWithIndex[]): string[] => {
  const tokenIds = new Set<string>([]);

  for (const input of inputs) {
    tokenIds.add(input.token);
  }

  for (const output of outputs) {
    tokenIds.add(output.token);
  }

  return [...tokenIds];
};

/**
 * Get the map of token balances for each wallet.
 *
 * @remarks
 * Different addresses can belong to the same wallet, so this function merges their
 * token balances.
 *
 * @example
 * Return map has this format:
 * ```
 * {
 *   wallet1: {token1: balance1, token2: balance2},
 *   wallet2: {token1: balance3}
 * }
 * ```
 *
 * @param addressWalletMap - Map of addresses and corresponding wallets
 * @param addressBalanceMap - Map of addresses and corresponding token balances
 * @returns A map of wallet ids and its token balances
 */
export const getWalletBalanceMap = (
  addressWalletMap: StringMap<Wallet>,
  addressBalanceMap: StringMap<TokenBalanceMap>,
): StringMap<TokenBalanceMap> => {
  const walletBalanceMap = {};
  for (const [address, balanceMap] of Object.entries(addressBalanceMap)) {
    const wallet = addressWalletMap[address];
    const walletId = wallet && wallet.walletId;

    // if this address is not from a started wallet, ignore
    if (!walletId) continue;

    walletBalanceMap[walletId] = TokenBalanceMap.merge(walletBalanceMap[walletId], balanceMap);
  }
  return walletBalanceMap;
};

/**
 * Get a wallet's balance, taking into account any existing timelocks.
 *
 * @remarks
 * If any timelock has expired, database tables will be refreshed before returning the balances.
 *
 * @param mysql - Database connection
 * @param now - Current timestamp
 * @param walletId - The wallet id
 * @param tokenIds - A list of token ids
 */
export const getWalletBalances = async (
  mysql: ServerlessMysql,
  now: number,
  walletId: string,
  tokenIds: string[] = [],
): Promise<WalletTokenBalance[]> => {
  let balances = await dbGetWalletBalances(mysql, walletId, tokenIds);

  // if any of the balances' timelock has expired, update the tables before returning
  const refreshBalances = balances.some((tb) => {
    if (tb.balance.lockExpires && tb.balance.lockExpires <= now) {
      return true;
    }
    return false;
  });

  if (refreshBalances) {
    const currentHeight = await getLatestHeight(mysql);
    const utxos = await getWalletUnlockedUtxos(mysql, walletId, now, currentHeight);
    await unlockUtxos(mysql, utxos, true);
    balances = await dbGetWalletBalances(mysql, walletId, tokenIds);
  }
  return balances;
};

/**
 * Searches our blocks database for the last block that is not voided.
 *
 * @param mysql - Database connection
 *
 * @returns A Block instance with the last block that is not voided.
 */
export const searchForLatestValidBlock = async (mysql: ServerlessMysql): Promise<Block> => {
  // Get our current best block.
  const latestHeight: number = await getLatestHeight(mysql);
  const bestBlock: Block = await getBlockByHeight(mysql, latestHeight);

  let start = 0;
  let end = bestBlock.height;
  let latestValidBlock = bestBlock;

  while (start <= end) {
    const midHeight = Math.floor((start + end) / 2);

    // Check if the block at middle position is voided
    const middleBlock: Block = await getBlockByHeight(mysql, midHeight);
    const [isVoided] = await isTxVoided(middleBlock.txId);

    if (!isVoided) {
      // Not voided, discard left half as all blocks to the left should
      // be valid, the reorg happened after this height.
      latestValidBlock = middleBlock;
      start = midHeight + 1;
    } else {
      end = midHeight - 1;
    }
  }

  return latestValidBlock;
};

/*
 * Receives a list of transactions that are being voided on a reorg and returns a list of transactions that spend them.
 *
 * Also marks wallet and addresses history that use this transaction as voided
 *
 * @param mysql - Database connection
 * @param txs - List of voided transactions to handle
 *
 * @returns A new list of voided transactions that are linked to the received list and a list of tx_outputs affected
 * by this iteration.
 */
export const handleVoidedTxList = async (mysql: ServerlessMysql, logger: Logger, txs: Tx[]): Promise<[Tx[], DbTxOutput[]]> => {
  logger.debug(`Setting ${txs.length} transactions as voided.`, {
    transactions: txs,
  });
  await markTxsAsVoided(mysql, txs);
  logger.debug(`Setting WalletTxHistory as voided from ${txs.length} transactions.`);
  await markWalletTxHistoryAsVoided(mysql, txs);
  logger.debug(`Setting AddressTxHistory as voided from ${txs.length} transactions.`);
  await markAddressTxHistoryAsVoided(mysql, txs);

  // tx outputs are the list of all outputs in the transaction list
  const txOutputs: DbTxOutput[] = await getTxOutputs(mysql, txs);

  logger.debug(`Fetched ${txOutputs.length} utxos from the voided transaction list`, {
    txOutputs,
  });

  // get outputs that were spent in txOutputs
  const txOutputsTxIds: Set<string> = txOutputs.reduce(
    (acc: Set<string>, txOutput: DbTxOutput) => acc.add(txOutput.txId),
    new Set<string>(),
  );

  // spent outputs are the list of outputs that were spent by those tx_outputs
  const spentOutputs: DbTxOutput[] = await getTxOutputsBySpent(mysql, [...txOutputsTxIds]);

  // unspend them as the tx_outputs that spent them are now voided
  if (spentOutputs.length > 0) {
    logger.debug(`Unspending ${spentOutputs.length} tx_outputs.`, {
      txOutputs: spentOutputs,
    });
    await unspendUtxos(mysql, [...spentOutputs]);
  }

  const affectedUtxoList = [...txOutputs, ...spentOutputs];

  // mark the tx_outputs from the received tx list as voided
  logger.debug(`Setting ${txOutputs.length} tx_outputs as voided.`, {
    txOutputs,
  });
  await markUtxosAsVoided(mysql, txOutputs);

  // get the list of tx ids that spend the tx_outputs list from the received tx list
  const txIds = txOutputs.reduce((acc: Set<string>, utxo: DbTxOutput) => {
    if (utxo.spentBy) {
      acc.add(utxo.spentBy);
    }

    return acc;
  }, new Set<string>());

  // fetch all transactions that spend those voided txs outputs:
  const newTxs = await getTransactionsById(mysql, [...txIds]);

  logger.debug(`Fetched ${newTxs.length} transactions that spend the voided tx outputs list`, {
    transactions: newTxs,
  });

  return [newTxs, affectedUtxoList];
};

/**
 * Handles a voided transaction by re-calculating the balances for all affected addresses after
 * removing the tx
 *
 * @param mysql - Database connection
 * @param tx - The voided transaction to remove
 */
export const handleVoided = async (mysql: ServerlessMysql, logger: Logger, tx: Tx): Promise<void> => {
  let txs: Tx[] = [tx];
  let affectedUtxoList: DbTxOutput[] = [];

  while (txs.length > 0) {
    const [newTxs, newAffectedUtxoList] = await handleVoidedTxList(mysql, logger, txs);
    txs = newTxs;
    affectedUtxoList = [...affectedUtxoList, ...newAffectedUtxoList];
  }

  // fetch all addresses and transactions affected by the voided transaction
  const [affectedAddresses, affectedTxIds] = affectedUtxoList.reduce(
    (acc: [Set<string>, Set<string>], utxo: DbTxOutput) => {
      acc[0].add(utxo.address);
      acc[1].add(utxo.txId);

      return acc;
    },
    [new Set<string>(), new Set<string>()],
  );

  if (affectedAddresses.size > 0) {
    const addresses = [...affectedAddresses];

    logger.debug(`Rebuilding balances for ${addresses.length} addresses.`, {
      addresses,
    });
    logger.debug(`Rebuilding tx count from ${affectedTxIds.size} transactions`, {
      affectedTxIds,
    });
    await rebuildAddressBalancesFromUtxos(mysql, addresses, [...affectedTxIds]);
    await validateAddressBalances(mysql, addresses);
  }

  logger.debug('Handle voided tx is done.');
};

export const validateAddressBalances = async (mysql: ServerlessMysql, addresses: string[]): Promise<void> => {
  const addressBalances: AddressBalance[] = await fetchAddressBalance(mysql, addresses);
  const addressTxHistorySums: AddressTotalBalance[] = await fetchAddressTxHistorySum(mysql, addresses);

  for (let i = 0; i < addressTxHistorySums.length; i++) {
    const addressBalance: AddressBalance = addressBalances[i];
    const addressTxHistorySum: AddressTotalBalance = addressTxHistorySums[i];

    assert.strictEqual(addressBalance.tokenId, addressTxHistorySum.tokenId);

    // balances must match
    assert.strictEqual(addressBalance.unlockedBalance + addressBalance.lockedBalance, addressTxHistorySum.balance);
  }
};

/**
 * Handles a reorg by finding the last valid block on the service's database and
 * removing transactions and tx_outputs before re-calculating the address balances.
 *
 * @param mysql - Database connection
 *
 * @returns The new best block height
 */
/* istanbul ignore next */
export const handleReorg = async (mysql: ServerlessMysql, logger: Logger): Promise<number> => {
  const { height } = await searchForLatestValidBlock(mysql);
  const currentHeight = await getLatestHeight(mysql);

  logger.debug(`Handling reorg. Our latest valid block is ${height} and our highest block height is ${currentHeight}`, {
    height,
    currentHeight,
  });

  if ((currentHeight - height) > WARN_MAX_REORG_SIZE) {
    logger.error(`A reorg with ${currentHeight - height} blocks has been detected`);
    await addAlert(
      'Big reorg detected',
      `A reorg with ${currentHeight - height} blocks has been detected`,
      Severity.MINOR,
      { walletServiceHeight: currentHeight, fullNodeHeight: height },
      logger,
    );
  }

  // fetch all block transactions where height > latestValidBlock
  const allTxsAfterHeight = await getTxsAfterHeight(mysql, height);
  let txs: Tx[] = allTxsAfterHeight.filter((tx) => [
    hathorLib.constants.BLOCK_VERSION,
    hathorLib.constants.MERGED_MINED_BLOCK_VERSION,
  ].indexOf(tx.version) > -1);

  // remove blocks where height > latestValidBlock as we already have them on memory
  await deleteBlocksAfterHeight(mysql, height);

  logger.debug('Removing transactions', txs.map((tx) => tx.txId));

  let affectedUtxoList: DbTxOutput[] = [];

  /*
   * Here we need to traverse the DAG of "funds", starting from the voided tx_outputs from the blocks
   * and stopping when there are no more linked tx_outputs voided.
   *
   * We do that by using a BFS, that mutates the DAG on every iteration (by setting the transactions
   * as voided on the database).
   */
  while (txs.length > 0) {
    const [newTxs, newAffectedUtxoList] = await handleVoidedTxList(mysql, logger, txs);

    txs = newTxs;
    affectedUtxoList = [...affectedUtxoList, ...newAffectedUtxoList];
  }

  // get all remaining txs and set height = null (mempool)
  const remainingTxs: Tx[] = await getTxsAfterHeight(mysql, height);
  if (remainingTxs.length > 0) {
    logger.debug(`Setting ${remainingTxs.length} unconfirmed transactions to the mempool (height = NULL).`, {
      remainingTxs,
    });
    await removeTxsHeight(mysql, remainingTxs);
  }

  // fetch all addresses and transactions affected by the reorg
  const [affectedAddresses, affectedTxIds] = affectedUtxoList.reduce(
    (acc: [Set<string>, Set<string>], utxo: DbTxOutput) => {
      acc[0].add(utxo.address);
      acc[1].add(utxo.txId);

      return acc;
    },
    [new Set<string>(), new Set<string>()],
  );

  if (affectedAddresses.size > 0) {
    const addresses = [...affectedAddresses];
    logger.debug(`Rebuilding balances for ${addresses.length} addresses.`, {
      addresses,
    });
    logger.debug(`Rebuilding tx count from ${affectedTxIds.size} transactions`, {
      affectedTxIds,
    });
    await rebuildAddressBalancesFromUtxos(mysql, addresses, [...affectedTxIds]);
    await validateAddressBalances(mysql, addresses);
  }

  logger.debug('Reorg is done.');

  return height;
};

export const walletIdProxyHandler = (handler: WalletProxyHandler): APIGatewayProxyHandler => (
  async (event, context) => {
    let walletId: string;
    try {
      walletId = event.requestContext.authorizer.principalId;
      // validate walletId?
    } catch (e) {
      return {
        statusCode: 401,
        body: 'Unauthorized',
      };
    }
    return handler(walletId, event, context);
  }
);

export const prepareOutputs = (outputs: TxOutput[], txId: string, logger: Logger): TxOutputWithIndex[] => {
  const preparedOutputs: [number, TxOutputWithIndex[]] = outputs.reduce(
    ([currIndex, newOutputs]: [number, TxOutputWithIndex[]], output: TxOutput): [number, TxOutputWithIndex[]] => {
      if (!output.decoded
          || output.decoded.type === null
          || output.decoded.type === undefined) {
        logger.warn(`Ignoring tx output with index ${currIndex} from tx ${txId} as script couldn't be decoded.`);
        return [currIndex + 1, newOutputs];
      }

      return [
        currIndex + 1,
        [
          ...newOutputs,
          {
            ...output,
            index: currIndex,
          },
        ],
      ];
    },
    [0, []],
  );

  return preparedOutputs[1];
};

/**
 * Get a list of wallet balance per token by informed transaction.
 *
 * @param mysql
 * @param tx - The transaction to get related wallets and their token balances
 * @returns
 */
export const getWalletBalancesForTx = async (mysql: ServerlessMysql, tx: Transaction): Promise<StringMap<WalletBalanceValue>> => {
  const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(tx.inputs, tx.outputs);
  // return only wallets that were started
  const addressWalletMap: StringMap<Wallet> = await getAddressWalletInfo(mysql, Object.keys(addressBalanceMap));

  // Create a new map focused on the walletId and storing its balance variation from this tx
  const walletsMap: StringMap<WalletBalance> = {};

  // Accumulation of tokenId to be used to extract its symbols.
  const tokenIdAccumulation = [];

  // Iterates all the addresses to populate the map's data
  const addressWalletEntries = stringMapIterator(addressWalletMap) as [string, Wallet][];
  for (const [address, wallet] of addressWalletEntries) {
    // Create a new walletId entry if it does not exist
    if (!walletsMap[wallet.walletId]) {
      walletsMap[wallet.walletId] = {
        txId: tx.tx_id,
        walletId: wallet.walletId,
        addresses: [],
        walletBalanceForTx: new TokenBalanceMap(),
      };
    }
    const walletData = walletsMap[wallet.walletId];

    // Add this address to the wallet's affected addresses list
    walletData.addresses.push(address);

    // Merge the balance of this address with the total balance of the wallet
    const mergedBalance = TokenBalanceMap.merge(walletData.walletBalanceForTx, addressBalanceMap[address]);
    walletData.walletBalanceForTx = mergedBalance;

    const tokenIdList = Object.keys(mergedBalance.map);
    tokenIdAccumulation.push(tokenIdList);
  }

  const tokenIdSet = new Set<string>(tokenIdAccumulation.reduce((prev, eachGroup) => [...prev, ...eachGroup], []));
  const tokenSymbolsMap = await getTokenSymbols(mysql, Array.from(tokenIdSet.values()));

  return WalletBalanceMapConverter.toValue(walletsMap, tokenSymbolsMap);
};
