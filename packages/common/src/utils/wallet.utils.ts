/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// @ts-ignore
import { constants } from '@hathor/wallet-lib';

/**
 * Checks if a given tokenData has any authority bit set
 *
 * tokenData merges two fields: first bit is the authority flag, while remaining
 * bits represent the token index. If the first bit is 0, this is a regular
 * output, if it's 1, it's an authority output
 */
export const isAuthority = (tokenData: number): boolean => (
  (tokenData & constants.TOKEN_AUTHORITY_MASK) > 0
);
