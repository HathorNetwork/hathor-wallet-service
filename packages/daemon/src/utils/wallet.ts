/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import hathorLib, { constants, Output, walletUtils, addressUtils } from '@hathor/wallet-lib';
import { Connection as MysqlConnection } from 'mysql2/promise';
import { strict as assert } from 'assert';
import {
  AddressBalance,
  AddressTotalBalance,
  DbTxOutput,
  EventTxInput,
  EventTxOutput,
  StringMap,
  TokenBalanceValue,
  Wallet,
  WalletBalance,
  WalletBalanceValue,
} from '../types';
import {
  DecodedOutput,
  Transaction,
  TxOutputWithIndex,
  TxInput,
  TxOutput,
  TokenBalanceMap,
  isDecodedValid,
} from '@wallet-service/common';
import {
  fetchAddressBalance,
  fetchAddressTxHistorySum,
  getAddressWalletInfo,
  getExpiredTimelocksUtxos,
  getTokenSymbols,
  unlockUtxos as dbUnlockUtxos,
  updateAddressLockedBalance,
  updateWalletLockedBalance,
} from '../db';
import logger from '../logger';
import { stringMapIterator } from './helpers';

/**
 * Prepares transaction outputs with additional metadata and indexing.
 *
 * This function expects a list  of EventTxOutput objects as inputs and an array
 * of tokens to produce an array of TxOutputWithIndex objects. Each output is
 * enhanced with additional data like the token it represents, its index in the
 * transaction, and its decoded information.
 *
 * @param outputs - An array of transaction outputs, each containing data like value,
 *                                    script, and token data.
 * @param tokens - An array of token identifiers corresponding to different tokens involved
 *                            in the transaction.
 * @returns - An array of outputs, each augmented with index and additional
 *                                  metadata.
 */
export const prepareOutputs = (outputs: EventTxOutput[], tokens: string[]): TxOutputWithIndex[] => {
  if (outputs.length === 0) {
    return [];
  }

  const preparedOutputs: [number, TxOutputWithIndex[]] = outputs.reduce(
    ([currIndex, newOutputs]: [number, TxOutputWithIndex[]], _output: EventTxOutput): [number, TxOutputWithIndex[]] => {
      // XXX: Output typing makes no sense here, maybe we should convert from Output to the wallet-service's own TxOutput
      const output = new Output(_output.value, Buffer.from(_output.script, 'base64'), {
        tokenData: _output.token_data,
      });

      let token = constants.NATIVE_TOKEN_UID;
      if (!output.isTokenHTR()) {
        token = tokens[output.getTokenIndex()];
      }
      // @ts-ignore
      output.token = token;

      if (!isDecodedValid(_output.decoded)
        || _output.decoded.type === null
        || _output.decoded.type === undefined) {
        console.log('Decode failed, skipping..');
        return [currIndex + 1, newOutputs];
      }

      // @ts-ignore
      output.locked = false;

      const finalOutput = {
        ...output,
        index: currIndex,
        decoded: _output.decoded,
        token_data: output.tokenData,
      };

      // @ts-ignore
      return [currIndex + 1, [...newOutputs, finalOutput,],];
    },
    [0, []],
  );

  return preparedOutputs[1];
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
    if (!isDecodedValid(input.decoded)) {
      // If we're unable to decode the script, we will also be unable to
      // calculate the balance, so just skip this input.
      continue;
    }

    const address = input.decoded?.address;

    // get the TokenBalanceMap from this input
    const tokenBalanceMap = TokenBalanceMap.fromTxInput(input);
    // merge it with existing TokenBalanceMap for the address
    // @ts-ignore
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  for (const output of outputs) {
    if (!isDecodedValid(output.decoded)) {
      throw new Error('Output has no decoded script');
    }

    if (!output.decoded.address) {
      throw new Error('Decoded output data has no address');
    }
    const address = output.decoded.address;

    // get the TokenBalanceMap from this output
    const tokenBalanceMap = TokenBalanceMap.fromTxOutput(output);

    // merge it with existing TokenBalanceMap for the address
    // @ts-ignore
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  return addressBalanceMap;
};

/**
 * Update the unlocked/locked balances for addresses and wallets connected to the given UTXOs.
 *
 * @param mysql - Database connection
 * @param utxos - List of UTXOs that are unlocked by height
 * @param updateTimelocks - If this update is triggered by a timelock expiring, update the next lock expiration
 */
export const unlockUtxos = async (mysql: MysqlConnection, utxos: DbTxOutput[], updateTimelocks: boolean): Promise<void> => {
  if (utxos.length === 0) return;

  const outputs: TxOutput[] = utxos.map((utxo) => {
    const decoded: DecodedOutput = {
      type: 'P2PKH',
      address: utxo.address,
      timelock: utxo.timelock,
    };

    return {
      value: utxo.authorities > 0 ? utxo.authorities : utxo.value,
      token: utxo.tokenId,
      decoded,
      locked: false,
      // set authority bit if necessary
      token_data: utxo.authorities > 0 ? constants.TOKEN_AUTHORITY_MASK : 0,
      // we don't care about spent_by and script
      spent_by: null,
      script: '',
    };
  });

  // mark as unlocked in database (this just changes the 'locked' flag)
  await dbUnlockUtxos(mysql, utxos.map((utxo: DbTxOutput): TxInput => ({
    tx_id: utxo.txId,
    index: utxo.index,
    value: utxo.value,
    token_data: 0,
    script: '',
    token: utxo.tokenId,
    decoded: null,
  })));

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

    // @ts-ignore
    walletBalanceMap[walletId] = TokenBalanceMap.merge(walletBalanceMap[walletId], balanceMap);
  }
  return walletBalanceMap;
};

/**
 * Update the unlocked/locked balances for addresses and wallets connected to the UTXOs that were unlocked
 * because of their timelocks expiring
 *
 * @param mysql - Database connection
 * @param now - Current timestamp
 */
export const unlockTimelockedUtxos = async (mysql: MysqlConnection, now: number): Promise<void> => {
  const utxos: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, now);

  await unlockUtxos(mysql, utxos, true);
};

/**
 * Prepares transaction input data for processing or display.
 *
 * This function takes an array of EventTxInput objects and an array of token identifiers
 * to prepare an array of TxInput objects. Each input is processed to include additional information
 * such as the token involved and the decoded output data.
 *
 * @param inputs - An array of transaction inputs, each containing data like
 *                                  transaction hash, index, and spent output information.
 * @param tokens - An array of token identifiers corresponding to different tokens involved
 *                            in the transaction.
 * @returns - An array of prepared inputs, each enriched with additional data.
 */
export const prepareInputs = (inputs: EventTxInput[], tokens: string[]): TxInput[] => {
  const preparedInputs: TxInput[] = inputs.reduce((newInputs: TxInput[], _input: EventTxInput): TxInput[] => {
    const output = _input.spent_output;
    const utxo: Output = new Output(output.value, Buffer.from(output.script, 'base64'), {
      tokenData: output.token_data,
    });
    let token = hathorLib.constants.NATIVE_TOKEN_UID;
    if (!utxo.isTokenHTR()) {
      token = tokens[utxo.getTokenIndex()];
    }

    const input: TxInput = {
      tx_id: _input.tx_id,
      index: _input.index,
      value: utxo.value,
      token_data: utxo.tokenData,
      // @ts-ignore
      script: utxo.script,
      token,
      decoded: isDecodedValid(output.decoded, ['type', 'address']) ? {
        type: output.decoded.type,
        address: output.decoded.address,
        // timelock might actually be null, so don't pass it to requiredKeys
        timelock: output.decoded.timelock,
      } : null,
    };

    return [...newInputs, input];
  }, []);

  return preparedInputs;
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
export const markLockedOutputs = (outputs: TxOutput[], now: number, hasHeightLock = false): void => {
  for (const output of outputs) {
    output.locked = false;
    if (hasHeightLock || (output.decoded?.timelock ? output.decoded?.timelock : 0) > now) {
      output.locked = true;
    }
  }
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
 * Validates the consistency of address balances.
 *
 * This method is designed to validate that the sum of unlocked and locked balances
 * for each address in a given set matches the corresponding total balance from the address's
 * transaction history.
 *
 * If any of these conditions are not met, the function will throw an assertion error, indicating a mismatch.
 *
 * @param mysql - The MySQL connection object to perform database operations.
 * @param addresses - An array of addresses whose balances need to be validated.
 * @returns - The function returns a promise that resolves to void. It does not return
 *                              any value but serves the purpose of validation.
 */
export const validateAddressBalances = async (mysql: MysqlConnection, addresses: string[]): Promise<void> => {
  const addressBalances: AddressBalance[] = await fetchAddressBalance(mysql, addresses);
  const addressTxHistorySums: AddressTotalBalance[] = await fetchAddressTxHistorySum(mysql, addresses);

  logger.debug(`Validating address balances for ${JSON.stringify(addresses)}`);

  /* We need to filter out zero transactions address balances as we won't have
   * any records in the address_tx_history table and the assertion ahead will
   * fail.
   *
   * This might happen after a re-org for an address that only had one transaction
   * as this transaction will be removed from the address_tx_history table (or
   * marked as voided) and the address_balance table will be updated, removing
   * one from the transactions column.
   */
  const filteredAddressBalances = addressBalances.filter(
    (addressBalance: AddressBalance) => addressBalance.transactions > 0
  );

  for (let i = 0; i < addressTxHistorySums.length; i++) {
    const addressBalance: AddressBalance = filteredAddressBalances[i];
    const addressTxHistorySum: AddressTotalBalance = addressTxHistorySums[i];

    assert.strictEqual(addressBalance.tokenId, addressTxHistorySum.tokenId);

    // balances must match
    assert.strictEqual(Number(addressBalance.unlockedBalance + addressBalance.lockedBalance), Number(addressTxHistorySum.balance));
  }
};

/**
 * Get a list of wallet balance per token by informed transaction.
 *
 * @param mysql
 * @param tx - The transaction to get related wallets and their token balances
 * @returns
 */
export const getWalletBalancesForTx = async (mysql: MysqlConnection, tx: Transaction): Promise<StringMap<WalletBalanceValue>> => {
  const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(tx.inputs, tx.outputs);
  // return only wallets that were started
  const addressWalletMap: StringMap<Wallet> = await getAddressWalletInfo(mysql, Object.keys(addressBalanceMap));

  // Create a new map focused on the walletId and storing its balance variation from this tx
  const walletsMap: StringMap<WalletBalance> = {};

  // Accumulation of tokenId to be used to extract its symbols.
  const tokenIdAccumulation = [];

  // Iterates all the addresses to populate the map's data
  const addressWalletEntries = stringMapIterator(addressWalletMap);
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

  // @ts-ignore
  return WalletBalanceMapConverter.toValue(walletsMap, tokenSymbolsMap);
};

export class FromTokenBalanceMapToBalanceValueList {
  /**
   * Convert the map of token balance instance into a map of token balance value.
   * It also hydrate each token balance value with token symbol.
   *
   * @param tokenBalanceMap - Map of token balance instance
   * @param tokenSymbolsMap - Map token's id to its symbol
   * @returns a map of token balance value
   */
  static convert(tokenBalanceMap: TokenBalanceMap, tokenSymbolsMap: StringMap<string>): TokenBalanceValue[] {
    const entryBalances = Object.entries(tokenBalanceMap.map);
    const balances = entryBalances.map(([tokenId, balance]) => ({
      tokenId,
      tokenSymbol: tokenSymbolsMap[tokenId],
      lockedAmount: balance.lockedAmount,
      lockedAuthorities: balance.lockedAuthorities.toJSON(),
      lockExpires: balance.lockExpires,
      unlockedAmount: balance.unlockedAmount,
      unlockedAuthorities: balance.unlockedAuthorities.toJSON(),
      totalAmountSent: balance.totalAmountSent,
      total: balance.total(),
    } as TokenBalanceValue));
    return balances;
  }
}

export const sortBalanceValueByAbsTotal = (balanceA: TokenBalanceValue, balanceB: TokenBalanceValue): number => {
  if (Math.abs(balanceA.total) - Math.abs(balanceB.total) >= 0) return -1;
  return 0;
};

export class WalletBalanceMapConverter {
  /**
   * Convert the map of wallet balance instance into a map of wallet balance value.
   *
   * @param walletBalanceMap - Map wallet's id to its balance
   * @param tokenSymbolsMap - Map token's id to its symbol
   * @returns a map of wallet id to its balance value
   */
  static toValue(walletBalanceMap: StringMap<WalletBalance>, tokenSymbolsMap: StringMap<string>): StringMap<WalletBalanceValue> {
    const walletBalanceEntries = Object.entries(walletBalanceMap);

    const walletBalanceValueMap: StringMap<WalletBalanceValue> = {};
    for (const [walletId, walletBalance] of walletBalanceEntries) {
      const sortedTokenBalanceList = FromTokenBalanceMapToBalanceValueList
        // hydrate token balance value with token symbol while convert to value
        .convert(walletBalance.walletBalanceForTx, tokenSymbolsMap)
        .sort(sortBalanceValueByAbsTotal);

      walletBalanceValueMap[walletId] = {
        addresses: walletBalance.addresses,
        txId: walletBalance.txId,
        walletId: walletBalance.walletId,
        walletBalanceForTx: sortedTokenBalanceList,
      };
    }

    return walletBalanceValueMap;
  }
}

/**
 * Generate a batch of addresses from a given xpubkey.
 *
 * @remarks
 * This function generates addresses starting from a specific index.
 *
 * @param xpubkey - The extended public key to derive addresses from
 * @param startIndex - The index to start generating addresses from
 * @param count - How many addresses to generate
 * @returns A map of addresses to their corresponding indices
 */
export const generateAddresses = async (
  network: string,
  xpubkey: string,
  startIndex: number,
  count: number,
): Promise<StringMap<number>> => {
  // We currently generate only addresses in change derivation path 0
  // (more details in https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#Change)
  // so we derive our xpub to this path and use it to get the addresses
  const derivedXpub = walletUtils.xpubDeriveChild(xpubkey, 0);
  const addrMap: StringMap<number> = {};
  for (let index = startIndex; index < startIndex + count; index++) {
    const address = addressUtils.deriveAddressFromXPubP2PKH(derivedXpub, index, network);
    addrMap[address.base58] = index;
  }

  return addrMap;
};
