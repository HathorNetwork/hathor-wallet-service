/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { USE_SSL, FULLNODE_HOST } from '../config';

export const getFullnodeHttpUrl = () => {
  const protocol = USE_SSL ? 'https://' : 'http://';

  return `${protocol}${FULLNODE_HOST}/v1a/`;
};

export const getFullnodeWsUrl = () => {
  const protocol = USE_SSL ? 'wss://' : 'ws://';

  return `${protocol}${FULLNODE_HOST}/v1a/event_ws`;
};
