/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { parseNullableBigInt } from '../../src/utils/helpers';

describe('parseNullableBigInt', () => {
  test('returns null for null', () => {
    expect(parseNullableBigInt(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(parseNullableBigInt(undefined)).toBeNull();
  });

  test('parses a numeric value into a bigint', () => {
    expect(parseNullableBigInt(42)).toEqual(42n);
  });

  test('parses a string value into a bigint', () => {
    expect(parseNullableBigInt('9007199254740993')).toEqual(9007199254740993n);
  });

  test('preserves zero (not treated as nullish)', () => {
    expect(parseNullableBigInt(0)).toEqual(0n);
    expect(parseNullableBigInt('0')).toEqual(0n);
  });
});
