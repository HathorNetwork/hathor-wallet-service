/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants } from "@hathor/wallet-lib";

export enum TokenInfoVersion {
  DEPOSIT = 1,

  FEE = 2,
}

export interface ITokenInfo {
  id: string;
  name: string;
  symbol: string;
  version?: TokenInfoVersion | null;
}

export interface ITokenInfoOptions extends ITokenInfo {
  transactions?: number;
}

export class TokenInfo implements ITokenInfo {
  id: string;

  name: string;

  symbol: string;

  transactions: number;

  version?: TokenInfoVersion | null;

  constructor({ id, name, symbol, version, transactions }: ITokenInfoOptions) {
    this.id = id;
    this.name = name;
    this.symbol = symbol;
    this.transactions = transactions || 0;
    this.version = version || TokenInfoVersion.DEPOSIT;

    // XXX: get config from settings?
    const hathorConfig = constants.DEFAULT_NATIVE_TOKEN_CONFIG;

    if (this.id === constants.NATIVE_TOKEN_UID) {
      this.name = hathorConfig.name;
      this.symbol = hathorConfig.symbol;
      this.version = null;
    }
  }

  toJSON(): ITokenInfo {
    return {
      id: this.id,
      name: this.name,
      symbol: this.symbol,
      version: this.version,
    };
  }
}
