/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Context } from '../machines/types';

const RETRY_BACKOFF_INCREASE = 1000; // 1s increase in the backoff strategy
const MAX_BACKOFF_RETRIES = 10; // The retry backoff will top at 10s

export const BACKOFF_DELAYED_RECONNECT = (context: Context) => {
  if (context.retryAttempt > MAX_BACKOFF_RETRIES) {
    return MAX_BACKOFF_RETRIES * RETRY_BACKOFF_INCREASE;
  }

  return context.retryAttempt * RETRY_BACKOFF_INCREASE;
};
