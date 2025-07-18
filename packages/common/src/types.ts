/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Alerts should follow the on-call guide for alerting, see
 * https://github.com/HathorNetwork/ops-tools/blob/master/docs/on-call/guide.md#alert-severitypriority
 */

import { constants } from '@hathor/wallet-lib';
import { isAuthority, isDecodedValid } from './utils/wallet.utils';

export interface StringMap<T> {
  [x: string]: T;
}

export enum Severity {
  CRITICAL = 'critical',
  MAJOR = 'major',
  MEDIUM = 'medium',
  MINOR = 'minor',
  WARNING = 'warning',
  INFO = 'info',
}

export interface Transaction {
  // eslint-disable-next-line camelcase
  tx_id: string;
  nonce: number;
  timestamp: number;
  // eslint-disable-next-line camelcase
  signal_bits: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: TxInput[];
  outputs: TxOutput[];
  height?: number;
  voided?: boolean | null;
  // eslint-disable-next-line camelcase
  token_name?: string | null;
  // eslint-disable-next-line camelcase
  token_symbol?: string | null;
}

export interface TxInput {
  // eslint-disable-next-line camelcase
  tx_id: string;
  index: number;
  value: bigint;
  // eslint-disable-next-line camelcase
  token_data: number;
  script: string;
  token: string;
  decoded?: DecodedOutput | null;
}

export interface TxOutput {
  value: bigint;
  script: string;
  token: string;
  decoded: DecodedOutput;
  // eslint-disable-next-line camelcase
  spent_by: string | null;
  // eslint-disable-next-line camelcase
  token_data: number;
  locked?: boolean;
}

export interface TxOutputWithIndex extends TxOutput {
  index: number;
}

export interface DecodedOutput {
  type: string;
  address: string;
  timelock: number | null;
}

export class Authorities {
  /**
   * Supporting up to 8 authorities (but we only have mint and melt at the moment)
   */
  static LENGTH = 8;

  array: number[];

  constructor(authorities?: bigint | number | number[]) {
    let tmp: number[] = [];
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
      mint: (authorities & constants.TOKEN_MINT_MASK) > 0, // eslint-disable-line no-bitwise
      melt: (authorities & constants.TOKEN_MELT_MASK) > 0, // eslint-disable-line no-bitwise
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

  constructor(
    totalAmountSent = 0n,
    unlockedAmount = 0n,
    lockedAmount = 0n,
    lockExpires: number|null = null,
    unlockedAuthorities: Authorities|null = null,
    lockedAuthorities: Authorities|null = null
  ) {
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
  static fromStringMap(tokenBalanceMap: StringMap<StringMap<bigint | number | Authorities>>): TokenBalanceMap {
    const obj = new TokenBalanceMap();
    for (const [tokenId, balance] of Object.entries(tokenBalanceMap)) {
      obj.set(tokenId, new Balance(
        balance.totalSent as bigint,
        balance.unlocked as bigint,
        balance.locked as bigint,
        balance.lockExpires as number || null,
        balance.unlockedAuthorities as Authorities,
        balance.lockedAuthorities as Authorities,
      ));
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
    if (!isDecodedValid(output.decoded)) {
      throw new Error('Output has no decoded script');
    }
    const token = output.token;
    const value = BigInt(output.value);
    const obj = new TokenBalanceMap();

    if (output.locked) {
      if (isAuthority(output.token_data)) {
        obj.set(token, new Balance(0n, 0n, 0n, output.decoded.timelock, new Authorities(0), new Authorities(output.value)));
      } else {
        obj.set(token, new Balance(value, 0n, value, output.decoded.timelock, new Authorities(0), new Authorities(0)));
      }
    } else if (isAuthority(output.token_data)) {
      obj.set(token, new Balance(0n, 0n, 0n, null, new Authorities(output.value), new Authorities(0)));
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
      obj.set(
        token,
        new Balance(0n, 0n, 0n, null, authorities.toNegative(), new Authorities(0)),
      );
    } else {
      obj.set(token, new Balance(0n, -BigInt(input.value), 0n, null));
    }
    return obj;
  }
}

// The output structure in full node events is similar to TxOutput but with some differences
export interface FullNodeOutput extends Omit<TxOutput, 'decoded' | 'token' | 'spent_by'> {
  // In full node data, decoded can be null
  decoded: DecodedOutput | null;
}

// The input structure in full node events is different - it contains a reference to the spent output
export interface FullNodeInput extends Omit<TxInput, 'value' | 'token_data' | 'script' | 'token' | 'decoded'> {
  // Instead of having these fields directly, it has a spent_output property
  spent_output: FullNodeOutput;
}

// The FullNodeTransaction interface represents a transaction as it comes from the full node
// which has a slightly different structure than our internal Transaction type
export interface FullNodeTransaction extends Omit<Transaction, 'tx_id' | 'inputs' | 'outputs' | 'parents'> {
  // From full node events we get 'hash' instead of 'tx_id'
  hash: string;
  // The input and output structures are different from our internal Transaction type
  inputs: FullNodeInput[];
  outputs: FullNodeOutput[];
  // Additional fields specific to full node events
  tokens: string[];
  parents?: string[];
  metadata?: {
    hash: string;
    voided_by: string[];
    first_block: null | string;
    height: number;
  };
}
