/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

 import { StringMap } from './utils';

export interface GenerateAddresses {
  addresses: string[];
  existingAddresses: StringMap<number>;
  newAddresses: StringMap<number>;
  lastUsedAddressIndex: number;
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

export type AddressIndexMap = StringMap<number>;

export interface Miner {
  address: string;
  firstBlock: string;
  lastBlock: string;
  count: number;
}
