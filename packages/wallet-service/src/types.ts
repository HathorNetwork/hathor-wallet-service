/* eslint-disable max-classes-per-file */

/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { TxInput, TxOutput } from '@wallet-service/common/src/types';

import hathorLib from '@hathor/wallet-lib';
import { isAuthority } from '@wallet-service/common/src/utils/wallet.utils';

import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
  Callback,
} from 'aws-lambda';

export interface StringMap<T> {
  [x: string]: T;
}

export type AddressIndexMap = StringMap<number>;

export interface GenerateAddresses {
  addresses: string[];
  existingAddresses: StringMap<number>;
  newAddresses: StringMap<number>;
  lastUsedAddressIndex: number;
}

export enum TxProposalStatus {
  OPEN = 'open',
  SENT = 'sent',
  SEND_ERROR = 'send_error',
  CANCELLED = 'cancelled',
}

/**
 * wallet-service environment config.
 */
export interface EnvironmentConfig {
  defaultServer: string;
  stage: string;
  network: string;
  serviceName: string;
  maxAddressGap: number;
  voidedTxOffset: number;
  confirmFirstAddress: boolean;
  wsDomain: string;
  dbEndpoint: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  dbPort: number;
  redisUrl: string;
  redisPassword: string;
  authSecret: string;
  walletServiceLambdaEndpoint: string;
  pushNotificationEnabled: boolean;
  pushAllowedProviders: string;
  isOffline: boolean;
  txHistoryMaxCount: number;
  healthCheckMaximumHeightDifference: number;
  awsRegion: string;
  firebaseProjectId: string;
  firebasePrivateKeyId: string;
  firebaseClientEmail: string;
  firebaseClientId: string;
  firebaseAuthUri: string;
  firebaseTokenUri: string;
  firebaseAuthProviderX509CertUrl: string;
  firebaseClientX509CertUrl: string;
  firebasePrivateKey: string|null;
  maxLoadWalletRetries: number;
  logLevel: string;
  createNftMaxRetries: number;
  warnMaxReorgSize: number;
};

/**
 * Fullnode converted version data.
 */
export interface FullNodeVersionData {
  version: string;
  network: string;
  minWeight: number;
  minTxWeight: number;
  minTxWeightCoefficient: number;
  minTxWeightK: number;
  tokenDepositPercentage: number;
  rewardSpendMinBlocks: number;
  maxNumberInputs: number;
  maxNumberOutputs: number;
  decimalPlaces: number;
  nativeTokenName: string;
  nativeTokenSymbol: string;
}

/**
 * Fullnode API response.
 */
export interface FullNodeApiVersionResponse {
  version: string;
  network: string;
  min_weight: number;
  min_tx_weight: number;
  min_tx_weight_coefficient: number; // float
  min_tx_weight_k: number;
  token_deposit_percentage: number; // float
  reward_spend_min_blocks: number;
  max_number_inputs: number;
  max_number_outputs: number;
  decimal_places?: number;
  genesis_block_hash?: string,
  genesis_tx1_hash?: string,
  genesis_tx2_hash?: string,
  native_token?: { name: string, symbol: string};
}

export interface TxProposal {
  id: string;
  walletId: string;
  status: TxProposalStatus;
  createdAt: number;
  updatedAt: number;
}

export enum WalletStatus {
  CREATING = 'creating',
  READY = 'ready',
  ERROR = 'error',
}

export interface Wallet {
  walletId: string;
  xpubkey: string;
  authXpubkey: string,
  maxGap: number;
  status?: WalletStatus;
  retryCount?: number;
  createdAt?: number;
  readyAt?: number;
}

export interface AddressInfo {
  address: string;
  index: number;
  transactions: number;
}

export interface ShortAddressInfo {
  address: string;
  index: number;
  addressPath: string;
}

export interface TokenBalance {
  tokenId: string;
  balance: Balance;
  transactions: number;
}

export class TokenInfo {
  id: string;

  name: string;

  symbol: string;

  transactions: number;

  constructor(id: string, name: string, symbol: string, transactions?: number) {
    this.id = id;
    this.name = name;
    this.symbol = symbol;
    this.transactions = transactions || 0;

    const hathorConfig = hathorLib.constants.DEFAULT_NATIVE_TOKEN_CONFIG;

    if (this.id === hathorLib.constants.NATIVE_TOKEN_UID) {
      this.name = hathorConfig.name;
      this.symbol = hathorConfig.symbol;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      symbol: this.symbol,
    };
  }
}

export class Authorities {
  /**
   * Supporting up to 8 authorities (but we only have mint and melt at the moment)
   */
  static LENGTH = 8;

  array: number[];

  constructor(authorities?: bigint | number | number[]) {
    let tmp = [];
    if (authorities instanceof Array) {
      tmp = authorities;
    } else if (authorities != null) {
      tmp = Authorities.intToArray(Number(authorities));
    }

    this.array = new Array(Authorities.LENGTH - tmp.length).fill(0).concat(tmp);
  }

  /**
   * Get the integer representation of this authority.
   *
   * @remarks
   * Uses the array to calculate the final number. Examples:
   * [0, 0, 0, 0, 1, 1, 0, 1] = 0b00001101 = 13
   * [0, 0, 1, 0, 0, 0, 0, 1] = 0b00100001 = 33
   *
   * @returns The integer representation
   */
  toInteger(): number {
    let n = 0;
    for (let i = 0; i < this.array.length; i++) {
      if (this.array[i] === 0) continue;

      n += this.array[i] * (2 ** (this.array.length - i - 1));
    }
    return n;
  }

  toUnsignedInteger(): number {
    return Math.abs(this.toInteger());
  }

  clone(): Authorities {
    return new Authorities(this.array);
  }

  /**
   * Return a new object inverting each authority value sign.
   *
   * @remarks
   * If value is set to 1, it becomes -1 and vice versa. Value 0 remains unchanged.
   *
   * @returns A new Authority object with the values inverted
   */
  toNegative(): Authorities {
    const finalAuthorities = this.array.map((value) => {
      // This if is needed because Javascript uses the IEEE_754 standard and has negative and positive zeros,
      // so (-1) * 0 would return -0.  Apparently -0 === 0 is true on most cases, so there wouldn't be a problem,
      // but we will leave this here to be safe.
      // https://en.wikipedia.org/wiki/IEEE_754
      if (value === 0) return 0;

      return (-1) * value;
    });
    return new Authorities(finalAuthorities);
  }

  /**
   * Return if any of the authorities has a negative value.
   *
   * @remarks
   * Negative values for an authority only make sense when dealing with balances of a
   * transaction. So if we consume an authority in the inputs but do not create the same
   * one in the output, it will have value -1.
   *
   * @returns `true` if any authority is less than 0; `false` otherwise
   */
  hasNegativeValue(): boolean {
    return this.array.some((authority) => authority < 0);
  }

  /**
   * Transform an integer into an array, considering 1 array element per bit.
   *
   * @returns The array given an integer
   */
  static intToArray(authorities: number): number[] {
    const ret = [];
    for (const c of authorities.toString(2)) {
      ret.push(parseInt(c, 10));
    }
    return ret;
  }

  /**
   * Merge two authorities.
   *
   * @remarks
   * The process is done individualy for each authority value. Each a1[n] and a2[n] are compared.
   * If both values are the same, the final value is the same. If one is 1 and the other -1, final
   * value is 0.
   *
   * @returns A new object with the merged values
   */
  static merge(a1: Authorities, a2: Authorities): Authorities {
    return new Authorities(a1.array.map((value, index) => Math.sign(value + a2.array[index])));
  }

  toJSON(): Record<string, unknown> {
    // TOKEN_MINT_MASK and TOKEN_MELT_MASK are bigint (since they come from the output amount)
    const authorities = BigInt(this.toInteger());
    return {
      mint: (authorities & hathorLib.constants.TOKEN_MINT_MASK) > 0, // eslint-disable-line no-bitwise
      melt: (authorities & hathorLib.constants.TOKEN_MELT_MASK) > 0, // eslint-disable-line no-bitwise
    };
  }
}

export class Balance {
  totalAmountSent: bigint;

  lockedAmount: bigint;

  unlockedAmount: bigint;

  lockedAuthorities: Authorities;

  unlockedAuthorities: Authorities;

  lockExpires: number | null;

  constructor(totalAmountSent = 0n, unlockedAmount = 0n, lockedAmount = 0n, lockExpires = null, unlockedAuthorities = null, lockedAuthorities = null) {
    this.totalAmountSent = totalAmountSent;
    this.unlockedAmount = unlockedAmount;
    this.lockedAmount = lockedAmount;
    this.lockExpires = lockExpires;
    this.unlockedAuthorities = unlockedAuthorities || new Authorities();
    this.lockedAuthorities = lockedAuthorities || new Authorities();
  }

  /**
   * Get the total balance, sum of unlocked and locked amounts.
   *
   * @returns The total balance
   */
  total(): bigint {
    return this.unlockedAmount + this.lockedAmount;
  }

  /**
   * Get all authorities, combination of unlocked and locked.
   *
   * @returns The combined authorities
   */
  authorities(): Authorities {
    return Authorities.merge(this.unlockedAuthorities, this.lockedAuthorities);
  }

  /**
   * Clone this Balance object.
   *
   * @returns A new Balance object with the same information
   */
  clone(): Balance {
    return new Balance(
      this.totalAmountSent,
      this.unlockedAmount,
      this.lockedAmount,
      this.lockExpires,
      this.unlockedAuthorities.clone(),
      this.lockedAuthorities.clone(),
    );
  }

  /**
   * Merge two balances.
   *
   * @remarks
   * In case lockExpires is set, it returns the lowest one.
   *
   * @param b1 - First balance
   * @param b2 - Second balance
   * @returns The sum of both balances and authorities
   */
  static merge(b1: Balance, b2: Balance): Balance {
    let lockExpires = null;
    if (b1.lockExpires === null) {
      lockExpires = b2.lockExpires;
    } else if (b2.lockExpires === null) {
      lockExpires = b1.lockExpires;
    } else {
      lockExpires = Math.min(b1.lockExpires, b2.lockExpires);
    }
    return new Balance(
      b1.totalAmountSent + b2.totalAmountSent,
      b1.unlockedAmount + b2.unlockedAmount,
      b1.lockedAmount + b2.lockedAmount,
      lockExpires,
      Authorities.merge(b1.unlockedAuthorities, b2.unlockedAuthorities),
      Authorities.merge(b1.lockedAuthorities, b2.lockedAuthorities),
    );
  }
}

export type TokenBalanceValue = {
  tokenId: string,
  tokenSymbol: string,
  totalAmountSent: bigint;
  lockedAmount: bigint;
  unlockedAmount: bigint;
  lockedAuthorities: Record<string, unknown>;
  unlockedAuthorities: Record<string, unknown>;
  lockExpires: number | null;
  total: bigint;
}

export class WalletTokenBalance {
  token: TokenInfo;

  balance: Balance;

  transactions: number;

  constructor(token: TokenInfo, balance: Balance, transactions: number) {
    this.token = token;
    this.balance = balance;
    this.transactions = transactions;
  }

  toJSON(): Record<string, unknown> {
    return {
      token: this.token,
      transactions: this.transactions,
      balance: {
        unlocked: this.balance.unlockedAmount,
        locked: this.balance.lockedAmount,
      },
      tokenAuthorities: {
        unlocked: this.balance.unlockedAuthorities,
        locked: this.balance.lockedAuthorities,
      },
      lockExpires: this.balance.lockExpires,
    };
  }
}

export interface TxTokenBalance {
  txId: string;
  timestamp: number;
  voided: boolean;
  balance: bigint;
  version: number;
}

export class TokenBalanceMap {
  map: StringMap<Balance>;

  constructor() {
    this.map = {};
  }

  get(tokenId: string): Balance {
    // if the token is not present, return 0 instead of undefined
    return this.map[tokenId] || new Balance(0n, 0n, 0n);
  }

  set(tokenId: string, balance: Balance): void {
    this.map[tokenId] = balance;
  }

  getTokens(): string[] {
    return Object.keys(this.map);
  }

  iterator(): [string, Balance][] {
    return Object.entries(this.map);
  }

  clone(): TokenBalanceMap {
    const cloned = new TokenBalanceMap();
    for (const [token, balance] of this.iterator()) {
      cloned.set(token, balance.clone());
    }
    return cloned;
  }

  /**
   * Return a TokenBalanceMap from js object.
   *
   * @remarks
   * Js object is expected to have the format:
   * ```
   * {
   *   token1: {unlocked: n, locked: m},
   *   token2: {unlocked: a, locked: b, lockExpires: c},
   *   token3: {unlocked: x, locked: y, unlockedAuthorities: z, lockedAuthorities: w},
   * }
   * ```
   *
   * @param tokenBalanceMap - The js object to convert to a TokenBalanceMap
   * @returns - The new TokenBalanceMap object
   */
  static fromStringMap(tokenBalanceMap: StringMap<StringMap<number | bigint | Authorities>>): TokenBalanceMap {
    const obj = new TokenBalanceMap();
    for (const [tokenId, balance] of Object.entries(tokenBalanceMap)) {
      obj.set(tokenId, new Balance(balance.totalSent as bigint, balance.unlocked as bigint, balance.locked as bigint, balance.lockExpires || null,
        balance.unlockedAuthorities, balance.lockedAuthorities));
    }
    return obj;
  }

  /**
   * Merge two TokenBalanceMap objects, merging the balances for each token.
   *
   * @param balanceMap1 - First TokenBalanceMap
   * @param balanceMap2 - Second TokenBalanceMap
   * @returns The merged TokenBalanceMap
   */
  static merge(balanceMap1: TokenBalanceMap, balanceMap2: TokenBalanceMap): TokenBalanceMap {
    if (!balanceMap1) return balanceMap2.clone();
    if (!balanceMap2) return balanceMap1.clone();
    const mergedMap = balanceMap1.clone();
    for (const [token, balance] of balanceMap2.iterator()) {
      const finalBalance = Balance.merge(mergedMap.get(token), balance);
      mergedMap.set(token, finalBalance);
    }
    return mergedMap;
  }

  /**
   * Create a TokenBalanceMap from a TxOutput.
   *
   * @param output - The transaction output
   * @returns The TokenBalanceMap object
   */
  static fromTxOutput(output: TxOutput): TokenBalanceMap {
    // TODO check if output.decoded exists, else return null
    const token = output.token;
    const value = output.value;
    const obj = new TokenBalanceMap();

    if (output.locked) {
      if (isAuthority(output.token_data)) {
        obj.set(token, new Balance(0n, 0n, 0n, output.decoded.timelock, 0, new Authorities(output.value)));
      } else {
        obj.set(token, new Balance(value, 0n, value, output.decoded.timelock, 0, 0));
      }
    } else if (isAuthority(output.token_data)) {
      obj.set(token, new Balance(0n, 0n, 0n, null, new Authorities(output.value), 0));
    } else {
      obj.set(token, new Balance(value, value, 0n, null));
    }

    return obj;
  }

  /**
   * Create a TokenBalanceMap from a TxInput.
   *
   * @remarks
   * It will have only one token entry and balance will be negative.
   *
   * @param input - The transaction input
   * @returns The TokenBalanceMap object
   */
  static fromTxInput(input: TxInput): TokenBalanceMap {
    const token = input.token;
    const obj = new TokenBalanceMap();

    if (isAuthority(input.token_data)) {
      // for inputs, the authorities will have a value of -1 when set
      const authorities = new Authorities(input.value);
      obj.set(token, new Balance(0n, 0n, 0n, null, authorities.toNegative(), new Authorities(0)));
    } else {
      obj.set(token, new Balance(0n, -input.value, 0n, null));
    }
    return obj;
  }
}

/**
 * Return type from ServerlessMysql#query after performing a SQL SELECT
 * (Array of objects containing the requested table fields.)
 */
export type DbSelectResult = Array<Record<string, unknown>>;

/**
 * Hathor types
 */

export interface TxOutputWithIndex extends TxOutput {
  index: number;
}

export interface IWalletOutput {
  address: string;
  value: number;
  token: string;
  tokenData: number;
  timelock: number;
}

export interface IWalletInput {
  txId: string;
  index: number;
}

export interface ApiResponse {
  success: boolean;
  message: string;
}

export type WsConnectionInfo = {
  id: string;
  url: string;
}

export type RedisConfig = {
  url: string;
  password?: string;
};

export interface Tx {
  txId: string;
  timestamp: number;
  version: number;
  voided: boolean;
  height?: number | null;
  weight: number;
}

export interface AddressBalance {
  address: string;
  tokenId: string;
  unlockedBalance: bigint;
  lockedBalance: bigint;
  unlockedAuthorities: number;
  lockedAuthorities: number;
  timelockExpires: number;
  transactions: number;
}

export interface AddressTotalBalance {
  address: string;
  tokenId: string;
  balance: bigint;
  transactions: number;
}

export interface DbTxOutput {
  txId: string;
  index: number;
  tokenId: string;
  address: string;
  value: bigint;
  authorities: number;
  timelock: number | null;
  heightlock: number | null;
  locked: boolean;
  spentBy?: string | null;
  txProposalId?: string;
  txProposalIndex?: number;
  voided?: boolean | null;
}

export interface Block {
  txId: string;
  height: number;
  timestamp: number;
}

// maybe use templates <TEvent = any, TResult = any>
export type WalletProxyHandler = (
  walletId: string,
  event?: APIGatewayProxyEvent,
  context?: Context,
  callback?: Callback<APIGatewayProxyResult>
) => Promise<APIGatewayProxyResult>;

export interface IFilterTxOutput {
  addresses: string[];
  tokenId?: string;
  authority?: number;
  ignoreLocked?: boolean;
  biggerThan?: bigint;
  smallerThan?: bigint;
  maxOutputs?: number;
  skipSpent?: boolean;
  txId?: string;
  index?: number;
}

export enum InputSelectionAlgo {
  USE_LARGER_UTXOS = 'use-larger-utxos',
}

export interface IWalletInsufficientFunds {
  tokenId: string;
  requested: bigint;
  available: bigint;
}

export interface DbTxOutputWithPath extends DbTxOutput {
  addressPath: string;
}

export interface Miner {
  address: string;
  firstBlock: string;
  lastBlock: string;
  count: number;
}

export enum PushProvider {
  IOS = 'ios',
  ANDROID = 'android'
}

export interface PushRegister {
  pushProvider: PushProvider,
  deviceId: string,
  enablePush?: boolean,
  enableShowAmounts?: boolean
}

export interface PushUpdate {
  deviceId: string,
  enablePush?: boolean,
  enableShowAmounts?: boolean
}

export interface PushDelete {
  deviceId: string,
}

export interface AddressAtIndexRequest {
  index?: number,
}

export interface TxByIdRequest {
  txId: string,
}

export interface TxByIdToken {
  txId: string;
  timestamp: number;
  version: number;
  voided: boolean;
  weight: number;
  balance: bigint;
  tokenId: string;
  tokenName: string;
  tokenSymbol: string;
}

export interface ParamValidationResult<ValueType> {
  error: boolean;
  details?: { message: string, path: (string | number)[] }[],
  value?: ValueType;
}

export interface GraphvizParams {
  txId: string;
  graphType: string;
  maxLevel: number;
}

export interface GetTxByIdParams {
  txId: string;
}

export interface GetConfirmationDataParams {
  txId: string;
}

export interface SendNotificationToDevice {
  deviceId: string,
  /**
   * A string map used to send data in the notification message.
   * @see LocalizeMetadataNotification
   *
   * @example
   * {
   *    "titleLocKey": "new_transaction_received_title",
   *    "bodyLocKey": "new_transaction_received_description_with_tokens",
   *    "bodyLocArgs": "['13 HTR', '8 TNT', '2']"
   * }
   */
  metadata: Record<string, string>,
}

export type LocalizeMetadataNotification = {
  titleLocKey: string,
  titleLocArgs: string,
  bodyLocKey: string,
  bodyLocArgs: string,
}

export interface PushDevice {
  walletId: string,
  deviceId: string,
  pushProvider: PushProvider,
  enablePush: boolean,
  enableShowAmounts: boolean
}

export type PushDeviceSettings = Omit<PushDevice, 'pushProvider'>;

export interface WalletBalance {
  txId: string,
  walletId: string,
  addresses: string[],
  walletBalanceForTx: TokenBalanceMap,
}

export interface WalletBalanceValue {
  txId: string,
  walletId: string,
  addresses: string[],
  walletBalanceForTx: TokenBalanceValue[],
}
