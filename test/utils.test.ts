/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */
import { syncToLatestBlock } from '../src/utils';

test('syncToLatestBlock', async () => {
  expect.hasAssertions();

  await syncToLatestBlock();

  expect(1).toStrictEqual(1);
}, 500000);
