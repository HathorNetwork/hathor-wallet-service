/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { loadEnvConfig } from '@src/config';

describe('loadSettleAlertMs', () => {
  const previous = process.env.LOAD_SETTLE_ALERT_MS;

  afterEach(() => {
    if (previous === undefined) delete process.env.LOAD_SETTLE_ALERT_MS;
    else process.env.LOAD_SETTLE_ALERT_MS = previous;
  });

  const withValue = (value: string | undefined): number => {
    if (value === undefined) delete process.env.LOAD_SETTLE_ALERT_MS;
    else process.env.LOAD_SETTLE_ALERT_MS = value;
    return loadEnvConfig().loadSettleAlertMs;
  };

  it('reads a whole number of milliseconds', () => {
    expect(withValue('45000')).toBe(45000);
    expect(withValue('0')).toBe(0);
  });

  it.each([undefined, '', 'abc', '-5', '30s', '1e5', '1.5'])('falls back to 30 s for %p', (value) => {
    expect(withValue(value)).toBe(30000);
  });
});
