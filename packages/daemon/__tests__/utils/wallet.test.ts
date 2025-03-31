/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { EventTxOutput } from '../../src/types';
import { prepareOutputs } from '../../src/utils';

/**
 * @jest-environment node
 */

describe('prepareOutputs', () => {
  it('should ignore NFT outputs', () => {
    const nftOutputs: EventTxOutput[] = [{
      value: 1n,
      token_data: 0,
      script: 'OmlwZnM6Ly9pcGZzL1FtTlJtNmhRUDN2MlVMclVOZTJQTTY4V1dRb2EyUmVwY1IxejVUVVdWZmd0bzGs',
      // @ts-expect-error: This type is wrong, we should allow null here in the type
      decoded: null
    }, {
      value: 2116n,
      token_data: 0,
      script: 'dqkUCU1EY3YLi8WURhDOEsspok4Y0XiIrA==',
      decoded: {
          type: 'P2PKH',
          address: 'H7NK2gjt5oaHzBEPoiH7y3d1NcPQi3Tr2F',
          timelock: null,
      }
    }, {
      value: 1n,
      token_data: 1,
      script: 'dqkUXO7BFkikXo2qwldGMeJlzyPSbtKIrA==',
      decoded: {
        type: 'P2PKH',
        address: 'HEzWZvoxDkZFnbmnK6BkQ8yw9xTyPXefGn',
        timelock: null,
      }
    }];

    const tokens = ['000013f562dc216890f247688028754a49d21dbb2b1f7731f840dc65585b1d57'];
    const preparedOutputs = prepareOutputs(nftOutputs, tokens);

    expect(preparedOutputs).toHaveLength(2);
    expect(preparedOutputs.find((output) => output.script === nftOutputs[0].script)).toBeUndefined();
  });
});
