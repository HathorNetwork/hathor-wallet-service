/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Map remembers the insertion order, so we can use it as a FIFO queue
export class LRU {
  max: number;

  cache: Map<string, any>;

  constructor(max: number = 10) {
    this.max = max;
    this.cache = new Map();
  }

  get(txId: string): string {
    const transaction = this.cache.get(txId);

    if (transaction) {
      this.cache.delete(txId);
      // Refresh it in the Map
      this.cache.set(txId, transaction);
    }

    return transaction;
  }

  set(txId: string, transaction: string): void {
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

