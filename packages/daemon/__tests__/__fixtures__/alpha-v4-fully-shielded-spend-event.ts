/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Event 70473 of testnet-shielded-outputs, fetched from an experimental-shielded-outputs-alpha-v4
// fullnode on 2026-10-05: a vertex with FullyShielded (mode=2) outputs that spends a shielded output.
export default {
  "type": "EVENT",
  "peer_id": "13dbaffe8647a39f2d16302950a3d92f6694b00a9081f138d0cc03bf2a96c76a",
  "network": "testnet-shielded-outputs",
  "event": {
    "id": 70473,
    "timestamp": 1790978822.9163718,
    "type": "NEW_VERTEX_ACCEPTED",
    "data": {
      "hash": "0036d59c43a3d0afa89026a54a7dd03cc1e91679791bc64eb0c7bfab909899d7",
      "nonce": 51,
      "timestamp": 1776734262,
      "signal_bits": 0,
      "version": 1,
      "weight": 8.000001,
      "inputs": [
        {
          "tx_id": "0098fb710e9cb55e626af2b5a9d6bad16d250a510b91d1bfd0952740eba63190",
          "index": 0,
          "spent_output": {
            "type": "shielded",
            "mode": 1,
            "commitment": "093a2a08665a038eb09bd146a7cb91b463ed7cb5cf297c5081dbde88fb590c19e9",
            "range_proof": "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",
            "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
            "ephemeral_pubkey": "03d748151b573049a13f0986e87d731318594972b6816fc4a735aa28ed41f83dfa",
            "token_data": 0,
            "asset_commitment": null,
            "surjection_proof": null,
            "decoded": {
              "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd"
            }
          }
        }
      ],
      "outputs": [],
      "shielded_outputs": [
        {
          "type": "shielded",
          "mode": 2,
          "commitment": "097ae5cdacd4ed81eb338dedb0aa3cf4207d45268410df3ec2eb76ce804e5d050c",
          "range_proof": "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",
          "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
          "ephemeral_pubkey": "024121f2f345a9eaa9a140f41d15faf320c5af7c9813d99a82f87419c112ec8570",
          "token_data": null,
          "asset_commitment": "0b71971a3a723e92c09cdfb4e07c558e69e5ee192c5f763708188551d8d6f1bd38",
          "surjection_proof": "AQAB+NANedxmKFjUrFpO6iN3lDyTOQCsEPeDcHJ8f4YJ8dH9yA+6v2Gfnc9hZtCx0YGrZWJeUjU4bL8C95XVAfVt2w==",
          "decoded": {
            "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd"
          }
        },
        {
          "type": "shielded",
          "mode": 2,
          "commitment": "08cdc3e04f0a66993261a316e5340ef4a973a49bfc48556b48080b6e0052f7f69a",
          "range_proof": "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",
          "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
          "ephemeral_pubkey": "029d9f11242674dd29911f5731cf403096dfb05c1370b12d4637edf3bad98135f5",
          "token_data": null,
          "asset_commitment": "0b1cbbcf03dc5ef3e3601c14db9e2b5ba7cf232182c4f261213cb6a0d2af5747b1",
          "surjection_proof": "AQABdMxoexpCfm2K8Dx5+EnOt0tsiemKs/z2lJMuPxqTQZTTVRMBwszm+cRaqzlKYQB+NglaYfTHhd7Uv/FN/lV6GA==",
          "decoded": {
            "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd"
          }
        }
      ],
      "parents": [
        "0098fb710e9cb55e626af2b5a9d6bad16d250a510b91d1bfd0952740eba63190",
        "00d26203d25a88167bce518e329895f5584fc38d214c2b82e8229395ff27e07e"
      ],
      "tokens": [],
      "token_name": null,
      "token_symbol": null,
      "aux_pow": null,
      "headers": [],
      "name": null,
      "metadata": {
        "hash": "0036d59c43a3d0afa89026a54a7dd03cc1e91679791bc64eb0c7bfab909899d7",
        "spent_outputs": [
          {
            "index": 0,
            "tx_ids": []
          },
          {
            "index": 1,
            "tx_ids": []
          }
        ],
        "conflict_with": [],
        "voided_by": [],
        "received_by": [],
        "twins": [],
        "accumulated_weight": 8.0,
        "score": 0.0,
        "accumulated_weight_raw": "256",
        "score_raw": "0",
        "first_block": null,
        "height": 0,
        "validation": "full",
        "nc_execution": null
      }
    },
    "group_id": null
  },
  "latest_event_id": 1056985,
  "stream_id": "87229fe3-d4fb-46ee-b7f5-67b068ee334b"
};
