/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants, TokenVersion } from '@hathor/wallet-lib';
import { DecodedOutput } from '../types';

/**
 * Safely converts a number to TokenVersion enum.
 * This function validates the number against known TokenVersion values.
 *
 * @param value - The number to convert
 * @returns The corresponding TokenVersion
 * @throws Error if the value is not a valid TokenVersion
 */
export const toTokenVersion = (value: number): TokenVersion => {
  if (value in TokenVersion) {
    return value as TokenVersion;
  }
  throw new Error(`Invalid TokenVersion: ${value}`);
};

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

/**
 * Checks if a decoded output object is valid (not null, undefined or empty object).
 *
 * @param decoded - The decoded output object to check
 * @param requiredKeys - A list of keys to check
 * @returns true if the decoded object is valid, false otherwise
 */
export const isDecodedValid = (decoded: any, requiredKeys: string[] = []): decoded is DecodedOutput => {
  return (decoded != null
    && typeof decoded === 'object'
    && Object.keys(decoded).length > 0)
    && requiredKeys.reduce((state, key: string) => (
      state && decoded[key] != null
    ), true);
};
