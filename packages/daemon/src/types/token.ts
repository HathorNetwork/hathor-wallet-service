/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants } from '@hathor/wallet-lib';

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

    // XXX: get config from settings?
    const hathorConfig = constants.DEFAULT_NATIVE_TOKEN_CONFIG;

    if (this.id === constants.NATIVE_TOKEN_UID) {
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
