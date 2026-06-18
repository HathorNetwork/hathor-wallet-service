/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import getConfig from '../config';
import { StringMap } from '../types';

export function stringMapIterator<T>(stringMap: StringMap<T>): [string, T][] {
  return Object.entries(stringMap);
}

/**
 * Parse a nullable numeric database column into a bigint.
 *
 * MySQL returns BIGINT columns as either a `number` or a `string` depending on
 * the driver/column, and `NULL` as `null`. This normalizes that to `bigint`,
 * preserving `null`/`undefined` as `null`.
 */
export function parseNullableBigInt(value: number | string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

export const getFullnodeHttpUrl = () => {
  const { USE_SSL, FULLNODE_HOST } = getConfig();
  const protocol = USE_SSL ? 'https://' : 'http://';

  const fullNodeUrl = new URL(`${protocol}${FULLNODE_HOST}`);
  fullNodeUrl.pathname = '/v1a';

  return fullNodeUrl.toString();
};

export const getFullnodeWsUrl = () => {
  const { USE_SSL, FULLNODE_HOST } = getConfig();
  const protocol = USE_SSL ? 'wss://' : 'ws://';

  const fullNodeUrl = new URL(`${protocol}${FULLNODE_HOST}`);
  fullNodeUrl.pathname = '/v1a/event_ws';

  return fullNodeUrl.toString();
};
