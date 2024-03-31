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
