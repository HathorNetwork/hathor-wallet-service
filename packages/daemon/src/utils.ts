/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { Connection as MysqlConnection } from 'mysql2/promise';
import { strict as assert } from 'assert';
import * as crypto from 'crypto';
// @ts-ignore
import hathorLib, { constants, Output } from '@hathor/wallet-lib';
import {
  AddressBalance,
  AddressTotalBalance,
  DbTxOutput,
  DecodedOutput,
  EventTxInput,
  EventTxOutput,
  StringMap,
  TokenBalanceMap,
  TxInput,
  TxOutput,
  TxOutputWithIndex,
  Wallet,
} from './types';
import {
  fetchAddressBalance,
  fetchAddressTxHistorySum,
  getAddressWalletInfo,
  getExpiredTimelocksUtxos,
  unlockUtxos as dbUnlockUtxos,
  updateAddressLockedBalance,
  updateWalletLockedBalance,
} from './db';

export const md5Hash = (data: string): string => {
  const hash = crypto.createHash('md5');
  hash.update(data);
  return hash.digest('hex');
};

export const serializeTxData = (meta: unknown): string =>
  // @ts-ignore
  `${meta.hash}|${meta.voided_by.length > 0}|${meta.first_block}|${meta.height}`;
export const hashTxData = (meta: unknown): string =>
// I'm interested in the hash, voided_by, first_block and height, we should
// serialize those fields as a string and then hash it

  // @ts-ignore
  md5Hash(serializeTxData(meta))
;

// Map remembers the insertion order, so we can use it as a FIFO queue
export class LRU {
  max: number;

  cache: Map<string, any>;

  constructor(max: number = 10) {
    this.max = max;
    this.cache = new Map();
  }

  get(txId: string): any {
    const transaction = this.cache.get(txId);

    if (transaction) {
      this.cache.delete(txId);
      // Refresh it in the Map
      this.cache.set(txId, transaction);
    }

    return transaction;
  }

  set(txId: string, transaction: any): void {
    if (this.cache.has(txId)) {
      // Refresh it in the map
      this.cache.delete(txId);
    }

    // Remove oldest
    if (this.cache.size === this.max) {
      this.cache.delete(this.first());
    }

    this.cache.set(txId, transaction);
  }

  first(): string {
    return this.cache.keys().next().value;
  }

  clear(): void {
    this.cache = new Map();
  }
}

export const isAuthority = (tokenData: number): boolean => (
  (tokenData & constants.TOKEN_AUTHORITY_MASK) > 0    // eslint-disable-line no-bitwise
);

export const prepareOutputs = (outputs: EventTxOutput[], tokens: string[]): TxOutputWithIndex[] => {
  const preparedOutputs: [number, TxOutputWithIndex[]] = outputs.reduce(
    ([currIndex, newOutputs]: [number, TxOutputWithIndex[]], _output: EventTxOutput): [number, TxOutputWithIndex[]] => {
      const output = new Output(_output.value, Buffer.from(_output.script, 'base64'), {
        tokenData: _output.token_data,
      });

      let token = '00';
      if (!output.isTokenHTR()) {
        token = tokens[output.getTokenIndex()];
      }
      output.token = token;

      if (!_output.decoded
          || _output.decoded.type === null
          || _output.decoded.type === undefined) {
        console.log('Decode failed, skipping..');
        return [currIndex + 1, newOutputs];
      }

      output.locked = false;

      const finalOutput = {
        ...output,
        index: currIndex,
        decoded: _output.decoded,
        token_data: output.tokenData,
      };

      return [
        currIndex + 1,
        [
          ...newOutputs,
          finalOutput,
        ],
      ];
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
    const address = input.decoded?.address;

    // get the TokenBalanceMap from this input
    const tokenBalanceMap = TokenBalanceMap.fromTxInput(input);
    // merge it with existing TokenBalanceMap for the address
    // @ts-ignore
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  for (const output of outputs) {
    if (!output.decoded) {
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
 * Get the current Unix timestamp, in seconds.
 *
 * @returns The current Unix timestamp in seconds
 */
export const getUnixTimestamp = (): number => (
  Math.round((new Date()).getTime() / 1000)
);

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
      token_data: utxo.authorities > 0 ? hathorLib.constants.TOKEN_AUTHORITY_MASK : 0,
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

export const prepareInputs = (inputs: EventTxInput[], tokens: string[]): TxInput[] => {
  const preparedInputs: TxInput[] = inputs.reduce((newInputs: TxInput[], _input: EventTxInput): TxInput[] => {
    const output = _input.spent_output;
    const utxo: Output = new Output(output.value, Buffer.from(output.script, 'base64'), {
      tokenData: output.token_data,
    });
    let token = '00';
    if (!utxo.isTokenHTR()) {
      token = tokens[utxo.getTokenIndex()];
    }

    const input: TxInput = {
      tx_id: _input.tx_id,
      index: _input.index,
      value: utxo.value,
      token_data: utxo.tokenData,
      script: utxo.script,
      token,
      decoded: {
        type: output.decoded.type,
        address: output.decoded.address,
        timelock: output.decoded.timelock,
      },
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

export const validateAddressBalances = async (mysql: MysqlConnection, addresses: string[]): Promise<void> => {
  const addressBalances: AddressBalance[] = await fetchAddressBalance(mysql, addresses);
  const addressTxHistorySums: AddressTotalBalance[] = await fetchAddressTxHistorySum(mysql, addresses);

  for (let i = 0; i < addressTxHistorySums.length; i++) {
    const addressBalance: AddressBalance = addressBalances[i];
    const addressTxHistorySum: AddressTotalBalance = addressTxHistorySums[i];

    assert.strictEqual(addressBalance.tokenId, addressTxHistorySum.tokenId);

    // balances must match
    assert.strictEqual(Number(addressBalance.unlockedBalance + addressBalance.lockedBalance), Number(addressTxHistorySum.balance));
  }
};
