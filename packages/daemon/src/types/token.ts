/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants, TokenVersion } from '@hathor/wallet-lib';

export class TokenInfo {
  id: string;

  name: string;

  symbol: string;

  transactions: number;

  version: TokenVersion;

  constructor(id: string, name: string, symbol: string, version: TokenVersion, transactions?: number) {
    this.id = id;
    this.name = name;
    this.symbol = symbol;
    this.transactions = transactions || 0;
    this.version = version;

    // XXX: currently we only support Hathor/HTR as the default token
    const hathorConfig = constants.DEFAULT_NATIVE_TOKEN_CONFIG;

    if (this.id === constants.NATIVE_TOKEN_UID) {
      this.name = hathorConfig.name;
      this.symbol = hathorConfig.symbol;
      this.version = hathorConfig.version;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      symbol: this.symbol,
      version: this.version,
    };
  }
}
