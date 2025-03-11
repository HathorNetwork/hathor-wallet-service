/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { getUnixTimestamp } from '@src/utils';
import { ServerlessMysql } from 'serverless-mysql';
import { getVersionData, updateVersionData } from '@src/db';
import { FullNodeVersionData, FullNodeApiVersionResponse } from '@src/types';
import fullnode from '@src/fullnode';

const VERSION_CHECK_MAX_DIFF = 60 * 60; // 1 hour

export async function getRawFullnodeData(mysql: ServerlessMysql): Promise<FullNodeApiVersionResponse> {
  const {
    timestamp,
    data: lastVersionData,
  } = await getVersionData(mysql);
  const now = getUnixTimestamp();

  if (!lastVersionData || now - timestamp > VERSION_CHECK_MAX_DIFF) {
    const versionData = await fullnode.version();
    await updateVersionData(mysql, timestamp, versionData);
    return versionData;
  }

  return lastVersionData;
}

export function convertApiVersionData(data: FullNodeApiVersionResponse): FullNodeVersionData {
  return {
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
}

export async function getFullnodeData(mysql: ServerlessMysql): Promise<FullNodeVersionData> {
  const data = await getRawFullnodeData(mysql);
  return convertApiVersionData(data);
}
