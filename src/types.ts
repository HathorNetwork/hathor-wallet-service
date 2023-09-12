/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { isAuthority } from './utils';
// @ts-ignore
import hathorLib from '@hathor/wallet-lib';

export interface Block {
  txId: string;
  height: number;
}

export interface DecodedScript {
  type?: string;
  address?: string;
  timelock?: number | undefined | null;
  value?: number | undefined | null;
  tokenData?: number | undefined | null;
}

export interface Input {
  txId: string;
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  index: number;
  token?: string | undefined | null;
}

export interface Output {
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  token?: string | undefined | null;
}

export interface Token {
  uid: string;
  // Hathor will return name: null and symbol: null
  name: string | null;
  symbol: string | null;
}

export interface FullTx {
  txId: string;
  nonce: string;
  timestamp: number;
  version: number;
  weight: number;
  voided?: boolean;
  parents: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  inputs: Input[];
  outputs: Output[];
  tokens?: Token[];
  height?: number;
  raw?: string;
}

export interface FullBlock {
  txId: string;
  nonce?: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  inputs: Input[];
  outputs: Output[];
  tokens?: Token[];
  height: number;
  raw?: string;
}

export interface ApiResponse {
  success: boolean;
  message?: string;
}

export interface DownloadBlockApiResponse extends ApiResponse {
  block: FullBlock;
}

export interface SyncSchema {
  states: {
    idle: {};
    mempoolsync: {};
    syncing: {};
    failure: {};
    ended: {};
    reorg: {};
  };
}

export interface SyncContext {
  hasMoreBlocks: boolean;
  hasMempoolUpdate: boolean;
  retryCount: number;
  error?: {};
}

/*
TODO: This is not being used in the machine, we should type all events.
export type SyncEvent =
  | { type: 'NEW_BLOCK'; message: any }
  | { type: 'STOP' };
*/

export interface HandlerEvent {
  type: string;
}

export type StatusEvent =
  | {
      type: 'finished';
      success: boolean;
      message?: string;
    }
  | {
      type: 'block_success';
      success: boolean;
      height?: number;
      blockId: string;
      message?: string;
      transactions: string[];
    }
  | {
      type: 'transaction_failure';
      success: boolean;
      message?: string;
    }
  | {
      type: 'reorg';
      success: boolean;
      message?: string;
    }
  | {
      type: 'error';
      success: boolean;
      message?: string;
      error?: string;
    };

export type MempoolEvent =
  | {
      type: 'finished';
      success: boolean;
      message?: string;
    }
  | {
      type: 'tx_success';
      success: boolean;
      txId: string;
      message?: string;
    }
  | {
      type: 'wait';
      success: boolean;
      message?: string;
    }
  | {
      type: 'error';
      success: boolean;
      message?: string;
      error?: string;
    };

/* export interface StatusEvent {
  type: string;
  success: boolean;
  blockId?: string;
  height?: number;
  transactions?: string[];
  message?: string;
  error?: string;
}; */

export interface GeneratorYieldResult<StatusEvent> {
  done?: boolean;
  value: StatusEvent;
}

export interface GeneratorYieldResult<StatusEvent> {
  done?: boolean;
  value: StatusEvent;
}

export interface PreparedDecodedScript {
  type: string;
  address: string;
  timelock?: number | undefined | null;
  value?: number;
  token_data?: number;
}

export interface PreparedInput {
  tx_id: string;
  value: number;
  token_data: number;
  script: string;
  decoded: PreparedDecodedScript;
  index: number;
  token: string;
}

export interface PreparedOutput {
  value: number;
  token_data: number;
  script: string;
  token: string;
  decoded: PreparedDecodedScript;
}

export interface PreparedTx {
  tx_id: string;
  inputs: PreparedInput[];
  outputs: PreparedOutput[];
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  nonce?: string;
  height?: number;
  tokens?: Token[];
  token_name?: string | null;
  token_symbol?: string | null;
  raw?: string;
}

export interface RawDecodedInput {
  type: string;
  address: string;
  timelock?: number | null;
  value: number;
  token_data: number;
}

/* Everything is optional because scripts that were not able to
 * be decoded will be returned as {}
 */
export interface RawDecodedOutput {
  type?: string;
  address?: string;
  timelock?: number | null;
  value?: number;
  token_data?: number;
}

export interface RawInput {
  value: number;
  token_data: number;
  script: string;
  decoded: RawDecodedInput;
  tx_id: string;
  index: number;
  token?: string | null;
  spent_by?: string | null;
}

export interface RawOutput {
  value: number;
  token_data: number;
  script: string;
  decoded: RawDecodedOutput;
  token?: string | null;
  spent_by?: string | null;
}

export interface RawTx {
  hash: string;
  nonce: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: RawInput[];
  outputs: RawOutput[];
  tokens: Token[];
  token_name?: string | null;
  token_symbol?: string | null;
  raw: string;
}

export interface Meta {
  hash: string;
  spent_outputs: any;
  received_by: string[];
  children: string[];
  conflict_with: string[];
  voided_by: string[];
  twins: string[];
  accumulated_weight: number;
  score: number;
  height: number;
  validation?: string;
  first_block?: string | null;
  first_block_height?: number | null;
}

export interface RawTxResponse {
  tx: RawTx;
  meta: Meta;
  success: boolean;
  message?: string;
  spent_outputs?: any;
}

export enum Severity {
  CRITICAL = 'critical',
  MAJOR = 'major',
  MEDIUM = 'medium',
  MINOR = 'minor',
  WARNING = 'warning',
  INFO = 'info',
}

export interface TxSendResult {
  success: boolean;
  message?: string;
}

export interface DecodedOutput {
  type: string;
  address: string;
  timelock: number | null;
}

export interface TxOutput {
  value: number;
  script: string;
  token: string;
  decoded: DecodedOutput | null;
  // eslint-disable-next-line camelcase
  spent_by: string | null;
  // eslint-disable-next-line camelcase
  token_data: number;
  locked?: boolean;
}

export interface TxOutputWithIndex extends TxOutput {
  index: number;
}

export interface TxInput {
  // eslint-disable-next-line camelcase
  tx_id: string;
  index: number;
  value: number;
  // eslint-disable-next-line camelcase
  token_data: number;
  script: string;
  token: string;
  decoded: DecodedOutput | null;
}

export interface EventTxInput {
  tx_id: string;
  index: number;
  value: number;
  script: string;
  token_data: number;
}

export interface DbTxOutput {
  txId: string;
  index: number;
  tokenId: string;
  address: string;
  value: number;
  authorities: number;
  timelock: number | null;
  heightlock: number | null;
  locked: boolean;
  spentBy?: string | null;
  txProposalId?: string;
  txProposalIndex?: number;
  voided?: boolean | null;
}

export interface StringMap<T> {
  [x: string]: T;
}

export class Authorities {
  /**
   * Supporting up to 8 authorities (but we only have mint and melt at the moment)
   */
  static LENGTH = 8;

  array: number[];

  constructor(authorities?: number | number[]) {
    let tmp: number[] = [];
    if (authorities instanceof Array) {
      tmp = authorities;
    } else if (authorities != null) {
      tmp = Authorities.intToArray(authorities);
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
    const authorities = this.toInteger();
    return {
      mint: (authorities & hathorLib.constants.TOKEN_MINT_MASK) > 0, // eslint-disable-line no-bitwise
      melt: (authorities & hathorLib.constants.TOKEN_MELT_MASK) > 0, // eslint-disable-line no-bitwise
    };
  }
}

export class Balance {
  totalAmountSent: number;

  lockedAmount: number;

  unlockedAmount: number;

  lockedAuthorities: Authorities;

  unlockedAuthorities: Authorities;

  lockExpires: number | null | undefined;

  constructor(totalAmountSent = 0, unlockedAmount = 0, lockedAmount = 0, lockExpires = null, unlockedAuthorities = null, lockedAuthorities = null) {
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
  total(): number {
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
      // @ts-ignore
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
      // @ts-ignore
      lockExpires = Math.min(b1.lockExpires, b2.lockExpires);
    }
    return new Balance(
      b1.totalAmountSent + b2.totalAmountSent,
      b1.unlockedAmount + b2.unlockedAmount,
      b1.lockedAmount + b2.lockedAmount,
      // @ts-ignore
      lockExpires,
      Authorities.merge(b1.unlockedAuthorities, b2.unlockedAuthorities),
      Authorities.merge(b1.lockedAuthorities, b2.lockedAuthorities),
    );
  }
}

export class TokenBalanceMap {
  map: StringMap<Balance>;

  constructor() {
    this.map = {};
  }

  get(tokenId: string): Balance {
    // if the token is not present, return 0 instead of undefined
    return this.map[tokenId] || new Balance(0, 0, 0);
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
  static fromStringMap(tokenBalanceMap: StringMap<StringMap<number | Authorities>>): TokenBalanceMap {
    const obj = new TokenBalanceMap();
    for (const [tokenId, balance] of Object.entries(tokenBalanceMap)) {
      // @ts-ignore
      obj.set(tokenId, new Balance(balance.totalSent as number, balance.unlocked as number, balance.locked as number, balance.lockExpires || null,
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
        // @ts-ignore
        obj.set(token, new Balance(0, 0, 0, output.decoded.timelock, 0, new Authorities(output.value)));
      } else {
        // @ts-ignore
        obj.set(token, new Balance(value, 0, value, output.decoded.timelock, 0, 0));
      }
    } else if (isAuthority(output.token_data)) {
      // @ts-ignore
      obj.set(token, new Balance(0, 0, 0, null, new Authorities(output.value), 0));
    } else {
      obj.set(token, new Balance(value, value, 0, null));
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
  static fromTxInput(input: DbTxOutput): TokenBalanceMap {
    const token = input.tokenId;
    const obj = new TokenBalanceMap();

    if (isAuthority(input.authorities)) {
      // for inputs, the authorities will have a value of -1 when set
      const authorities = new Authorities(input.value);
      obj.set(
        token,
        new Balance(
          0,
          0,
          0,
          null,
          // @ts-ignore
          authorities.toNegative(),
          new Authorities(0)
        ),
      );
    } else {
      obj.set(token, new Balance(0, -input.value, 0, null));
    }
    return obj;
  }
}

export interface TxByIdToken {
  txId: string;
  timestamp: number;
  version: number;
  voided: boolean;
  weight: number;
  balance: Balance;
  tokenId: string;
  tokenName: string;
  tokenSymbol: string;
}

export interface Transaction {
  // eslint-disable-next-line camelcase
  tx_id: string;
  nonce: number;
  timestamp: number;
  // eslint-disable-next-line camelcase
  voided: boolean;
  signal_bits: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: TxInput[];
  outputs: TxOutput[];
  height?: number;
  // eslint-disable-next-line camelcase
  token_name?: string;
  // eslint-disable-next-line camelcase
  token_symbol?: string;
}
