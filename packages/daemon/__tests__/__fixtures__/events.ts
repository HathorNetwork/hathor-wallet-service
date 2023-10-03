/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export default {
  VERTEX_METADATA_CHANGED: {
    type: 'EVENT',
    event: {
      stream_id: 'f7d9157c-9906-4bd2-bc84-cfb9f5b607d1',
      network: 'mainnet',
      peer_id: 'bdf4fa876f5cdba84be0cab53b21fc9eb45fe4b3d6ede99f493119d37df4e560',
      id: 37,
      timestamp: 1572653409.0,
      type: 'VERTEX_METADATA_CHANGED',
      data: {
        hash: 'f42fbcd1549389632236f85a80ad2dd8cac2f150501fb40b11210bad03718f79',
        nonce: 2,
        timestamp: 1572653369,
        version: 1,
        weight: 18.664694903964126,
        inputs: [{
          tx_id: 'd8d221392cda50bdb2c4bef1f11f826ddcad85ddab395d062d05fc4a592195c2',
          index: 0,
          data: 'SDBGAiEAwRECSYXApimxuQ9cD88w9U0N+SdAtJZfi0x1e3VgGmYCIQDsIsEC2nZzWgIa1U+eh/pIzhMg0rKvH3u8BaRLCpz4ICEC6Y5mbQB/qe5dH40iULOaEGoGq9CKeQMumnT8+yyMIHM=',
        }],
        outputs: [{
          value: 1431,
          script: 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==',
          token_data: 0
        }, {
          value: 4969,
          script: 'dqkUm3CeNv0dX1HsZAvl2H0Cr6NZ40CIrA==',
          token_data: 0
        }],
        parents: ['16ba3dbe424c443e571b00840ca54b9ff4cff467e10b6a15536e718e2008f952', '33e14cb555a96967841dcbe0f95e9eab5810481d01de8f4f73afb8cce365e869'],
        tokens: [],
        token_name: null,
        token_symbol: null,
        metadata: {
          hash: 'f42fbcd1549389632236f85a80ad2dd8cac2f150501fb40b11210bad03718f79',
          spent_outputs: [{
            index: 0,
            tx_ids: ['58fba3126e91f546fc11792637d0c4112e2de12920628f98ca1abe4fa97cc74f']
          }, {
            index: 1,
            tx_ids: ['58fba3126e91f546fc11792637d0c4112e2de12920628f98ca1abe4fa97cc74f']
          }],
          conflict_with: [],
          voided_by: [],
          received_by: [],
          children: ['58fba3126e91f546fc11792637d0c4112e2de12920628f98ca1abe4fa97cc74f', '01375179ce0f6a6d6501fec0ee14dba8e134372a8fe6519aa952ced7b0577aaa'],
          twins: [],
          accumulated_weight: 18.664694903964126,
          score: 0.0,
          first_block: '01375179ce0f6a6d6501fec0ee14dba8e134372a8fe6519aa952ced7b0577aaa',
          height: 0,
          validation: 'full'
        },
        aux_pow: null
      },
      group_id: null
    },
    latest_event_id: 38
  },
  NEW_VERTEX_ACCEPTED: {
    type: 'EVENT',
    event: {
      peer_id: '9083fc84b47a475862b97534296b9713bb05e6dcd6640b804be4c20c3639d3f5',
      id: 49,
      timestamp: 1691028449.1147473,
      type: 'NEW_VERTEX_ACCEPTED',
      data: {
        hash: '00000000171cb374cb433745b4080bcc7a44f42c4f563af1a624eea588f3f146',
        nonce: 297718091,
        timestamp: 1578077286,
        version: 0,
        weight: 34.879398065365535,
        inputs: [],
        outputs: [{
          value: 6400,
          script: 'dqkUym0SWcUWwA1Du+i9fiZl4MbEfwWIrA==',
          token_data: 0,
        }],
        parents: ['00000000008fe9c79211df3d1e2236202839534e1dab2fce587d7c4360d8b0b4', '0002d4d2a15def7604688e1878ab681142a7b155cbe52a6b4e031250ae96db0a', '0002ad8d1519daaddc8e1a37b14aac0b045129c01832281fb1c02d873c7abbf9'],
        tokens: [],
        token_name: null,
        token_symbol: null,
        metadata: {
          hash: '00000000171cb374cb433745b4080bcc7a44f42c4f563af1a624eea588f3f146',
          spent_outputs: [],
          conflict_with: [],
          voided_by: [],
          received_by: [],
          children: ['0000000009c21644558a29eb5e89061a993b8241b2580d26071b7d3efd7a9e03'],
          twins: [],
          accumulated_weight: 34.879398065365535,
          score: 42.309318350260796,
          first_block: null,
          height: 46,
          validation: 'full',
        },
        aux_pow: null,
      },
      group_id: null,
    },
    latest_event_id: 5089156
  },
  REORG_STARTED: {
    type: 'EVENT',
    event: {
      peer_id: '34370eed38ad67ef3d95fe005acdf182de6e0d50ebbea6d8234d9ee07e46ed1b',
      id: 5524457,
      timestamp: 1696040277.2181926,
      type: 'REORG_STARTED',
      data: {
        reorg_size: 1,
        previous_best_block: '000000000000000063345d97b451acc930eb7c1e15473bcfeb30797b8c417621',
        new_best_block: '000000000000000135496ab5bd8a8d3ecf249fc19f6ee41afdf2230722900a60',
        common_block: '000000000000000406a302805d80634675b1e9d2bab6e26d5b326abb3303e8ba'
      },
      group_id: 1500,
    },
  }
};
