/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Event 47541 of testnet-shielded-outputs, fetched from an experimental-shielded-outputs-alpha-v4
// fullnode on 2026-10-05: the first vertex with shielded outputs on that chain.
export default {
  "type": "EVENT",
  "peer_id": "13dbaffe8647a39f2d16302950a3d92f6694b00a9081f138d0cc03bf2a96c76a",
  "network": "testnet-shielded-outputs",
  "event": {
    "id": 47541,
    "timestamp": 1790978735.2250557,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000002e24ed8c1a2327ad90260572533d4460931e812aa8d24f78806333a14e3",
      "nonce": 222962,
      "timestamp": 1776392731,
      "signal_bits": 0,
      "version": 1,
      "weight": 21.778869923098963,
      "inputs": [
        {
          "tx_id": "000005d7776cd4ea884d2726f119c2e1bb8bdc19afdca4d0910601afecf70a96",
          "index": 1,
          "spent_output": {
            "value": 1000,
            "token_data": 0,
            "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
            "decoded": {
              "type": "P2PKH",
              "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd",
              "timelock": null
            }
          }
        }
      ],
      "outputs": [],
      "shielded_outputs": [
        {
          "type": "shielded",
          "mode": 1,
          "commitment": "09bba2bd0f765e57b40c113f1cd576455b336a7810c415e81eb97ebd468686a8e6",
          "range_proof": "YAcAAAAAAAAAAQFYCfdm5Wv8EUtft2CUDwXhbUQ5UCagU+JGssVT+FJ8EKFFSJ7Cs1it7hU3Ml8Bj0x2kJY7O0cHqFBGwJhbPB0puh+K6WB29EeHzMQhZBbHRftRhoH2Vzjy2w3y41v2amiYieO9bjzqKncVOnMrz8pzdn+pScX4dxSqkke41dSpF+MqS/l/KJkT/KsZDlIy30PE3IzPOUZKeV6roMaxhQChpXMYzt5+f75uB8kFeE0Tin+lEYgaUH9w6v0d/lu3ap8/H9z/xvXbVYYVk+Qfrcy2kp1/UJnMrdgXDx9agCrQt5oWFkMr4Ct2CxuAPgfCNhaUbQ9Hc0hcKKAQAprd5bfUMq0VcjL0tvwakSldaJ4mgSzwMKHCE/tbQkWe2lU7wMau4OZtyD8Nfi/q/Vm8MVOuf/kh/taf0l+Mcvs7dnDFAKtiaWZkSVSLhwwFLIGrZJgWt90HmR4YTb/sMGCD+Fiqgp6ybpdvjvhK8GUaFRPGLA9oytW5lNRu3a6es3VvfEf679SbI9Rk6+qRbbXhALSkzAr1ruFPIRWYRVFzKEkCnp0cpuOq3tR/OStIMdL4zjbqnvDUOAKkonHM3vDmXoc4QNph2XNHeGNWOJcNEAd1cIAAXzf8y3RAh4yE/rw6jrmU1cL1UZdPjp+GNgnXh6nX+izqPEJ+Wu0Lr8HdWppb2AYcmTq5UIkhznqr39kE1EyWbTDp8Ihd3wfuPnbi3zLl40io7aKvfcWaesy7lhNsskpi3AbIDtpKQMCYUf+Z3glIrxot5bqHlN+LvuWqBuweJDK2Uf9GOI3GSicH9M/p07cqyQR7a9bvuoTpZFV261SNmwdEJHymNGEeakG1SNqx",
          "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
          "ephemeral_pubkey": "02b98ba00642bcb3c3af90ca7b3c2866132b362c79a9730d805fcd67ade18b4bb7",
          "token_data": 0,
          "asset_commitment": null,
          "surjection_proof": null,
          "decoded": {
            "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd"
          }
        },
        {
          "type": "shielded",
          "mode": 1,
          "commitment": "09e48d1686dccf4b6eef0874fae7ab6bdc6957e47cf4c6d45429f47478e3ab5053",
          "range_proof": "YAkAAAAAAAAAAQHV6fQ/YnEx5iWzm4B+PYF8STAdQNRpsOtzZL0P8CXv9gPTi0DSRuCK072pcGKhmir77RxfzTeHZ0Kd20Xp3nNyQtiLG1OjdyzIKtkQUduvwJPfG7jIboTTORvBs4o9rRGZjxPjL18AR86QGNLIEDDP7FbJ2pozOnxMuH5LCmT4fcg9YV6SLTwMafVW73JYGApZrTA7AkFySdbQctJ0h6eyZZrmyKzORzW/JWBwr0g30owDoN6YhJbH5fRlw7gBf7ZMxpMF2h/hGYnOu3BaDIY2dzrN0tTxXcr85aSQUXuv/BFzZi3X+icGTlqTfWafrO47Wh81OTguDZT45NzJPDBG9bRtRnaqn4ClYVji/TlJEYyMWBbIK3G68/ikEBBJ0VKmnqmAFjXcGrIQa2tjoneeNqLxNgCHoCKWZ1Z8NK8M10idB8FgD95OPBACtsCRDk9T+3DsRuXwWDNYnS2iGPYP4waFgg1+lYCIvyjITrbU1SF9OFQupU7i25ZAG7X7GWxxUUyNFD2IKOJufGzbGZhf7fJDY+J9ak/MWcH22WLgzN1YtuUYBhJLQdEIpY2kbG3zTO8HvxEvksvOA24iu1mCCFYfumW91wIvtvjktnkSnZF9qEg+J8vMYLrkH+y06/VuvCyCO3xsFlwCwkGHRygIXtxct3oTyuDsN0lSQMZ1P1tKTVP4meh/qgxF4Lr72jgAKrgtYxqKTZu0pauQyOyNxLogNnlFMVpYAuYfcL54ObCMxebCzpkGiyXVdw2z7nNOEZrpYcLOuU4/cGtMQ7RbWyU+p4ejD8yeMXtfK8aGh77JSjkp+imsgfTj4uUCenPY31JPjIfdHsWLe2tY05Ud/AkCDX9qVkHLuX+t4ArWd6saLuBAiJExxcilNHVrlRUhLzJjcrGRcwDSKlyHAdFDrgmv1GBB3EyUjL8h23OPP0fDVEPirQlm1OtOdggdsyuhAu0FI2kT60iEB7xVgimWKEKL/rbSLLexduMPQLZcAq0tDP2/FCwiuVGWPB0EF9EztiBlxZ5dYDCOJSGS4/s7PTu7t71NLI83GnIpYsHEnw==",
          "script": "dqkUXUF4UiYHVkw0MqUfnuw77H7iwOWIrA==",
          "ephemeral_pubkey": "031d2eaf5dab629e75e08f56990070a182d95c5e9f904f46d8c7d66007b1952aff",
          "token_data": 0,
          "asset_commitment": null,
          "surjection_proof": null,
          "decoded": {
            "address": "WXB89hktXkbjusPzcDxvmFfdkhKBo4fAnd"
          }
        }
      ],
      "parents": [
        "000001db73142cd9062dc01504bbdbc29a1167313845a39f8fd776fa3dcb208b",
        "000005d7776cd4ea884d2726f119c2e1bb8bdc19afdca4d0910601afecf70a96"
      ],
      "tokens": [],
      "token_name": null,
      "token_symbol": null,
      "aux_pow": null,
      "headers": [],
      "name": null,
      "metadata": {
        "hash": "000002e24ed8c1a2327ad90260572533d4460931e812aa8d24f78806333a14e3",
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
        "accumulated_weight": 21.778870009417577,
        "score": 0.0,
        "accumulated_weight_raw": "3598265",
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
