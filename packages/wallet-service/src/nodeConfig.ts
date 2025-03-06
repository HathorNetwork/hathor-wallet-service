/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { getUnixTimestamp } from '@src/utils';
import { ServerlessMysql } from 'serverless-mysql';
import { getVersionData, updateVersionData } from '@src/db';
import { FullNodeVersionData } from '@src/types';
import fullnode from '@src/fullnode';

const VERSION_CHECK_MAX_DIFF = 60 * 60 * 1000; // 1 hour

export class NodeConfig {
  fullnodeVersion: FullNodeVersionData | null = null;
  setFullnodeVersion(data: FullNodeVersionData) {
    this.fullnodeVersion = data;
  }

  async refreshFullnodeVersion() {
    // Get data from fullnode version api
    const data = await fullnode.version();

    const now = getUnixTimestamp();
    const fullnodeVersion = {
      timestamp: now,
      version: data.version,
      network: data.network,
      minWeight: data.min_weight,
      minTxWeight: data.min_tx_weight,
      minTxWeightCoefficient: data.min_tx_weight_coefficient,
      minTxWeightK: data.min_tx_weight_k,
      tokenDepositPercentage: data.token_deposit_percentage,
      rewardSpendMinBlocks: data.reward_spend_min_blocks,
      maxNumberInputs: data.max_number_inputs,
      maxNumberOutputs: data.max_number_outputs,
      decimalPlaces: data.decimal_places,
      nativeTokenName: data.native_token.name,
      nativeTokenSymbol: data.native_token.symbol,
    };
    this.setFullnodeVersion(fullnodeVersion);
  }

  async getFullnodeData(mysql: ServerlessMysql): Promise<FullNodeVersionData> {
    const lastVersionData = await getVersionData(mysql);
    const now = getUnixTimestamp();

    if (!lastVersionData || now - lastVersionData.timestamp > VERSION_CHECK_MAX_DIFF) {
      await this.refreshFullnodeVersion();
      await updateVersionData(mysql, this.fullnodeVersion);
    } else if (this.fullnodeVersion === null) {
      this.fullnodeVersion = lastVersionData;
    }

    return this.fullnodeVersion;
  }
}
