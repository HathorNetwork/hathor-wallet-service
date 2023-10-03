/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as crypto from 'crypto';

/**
 * Generates an MD5 hash of the provided string data.
 * 
 * @param data - The string data to hash.
 * @returns - The MD5 hash of the data in hexadecimal format.
 */
export const md5Hash = (data: string): string => {
  const hash = crypto.createHash('md5');
  hash.update(data);
  return hash.digest('hex');
};

/**
 * Serializes select transaction metadata attributes into a string format.
 * 
 * @param meta - The transaction metadata to serialize.
 * @returns - A serialized string representing specific fields of the metadata.
 */
export const serializeTxData = (meta: unknown): string =>
  // @ts-ignore
  `${meta.hash}|${meta.voided_by.length > 0}|${meta.first_block}|${meta.height}`;

/**
 * Hashes transaction metadata using MD5.
 * 
 * Serializes the relevant fields of transaction metadata and then computes its MD5 hash.
 * 
 * @param meta - The transaction metadata to hash.
 * @returns - The MD5 hash of the serialized metadata.
 */
export const hashTxData = (meta: unknown): string =>
  md5Hash(serializeTxData(meta))
;
