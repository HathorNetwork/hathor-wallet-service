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
import { constants } from '@hathor/wallet-lib';

const VERSION_CHECK_MAX_DIFF = 60 * 60; // 1 hour

/**
 * Get fullnode version data as an Object exactly as the fullnode sent it.
 * Will get from database if the cached version data is valid.
 */
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

/**
 * Convert the raw version data from the fullnode to a camel-cased object.
 */
export function convertApiVersionData(data: FullNodeApiVersionResponse): FullNodeVersionData {
  return {
    version: data.version,
    network: data.network,
    // NOTE: Due to a bug in older fullnode versions, nano_contracts_enabled may return
    // string values ('disabled', 'enabled', 'feature_activation') instead of boolean.
    // This will be fixed in future fullnode versions to return boolean only.
    // Until then, we need to handle both string and boolean values.
    nanoContractsEnabled: data.nano_contracts_enabled === true || data.nano_contracts_enabled === 'enabled' || data.nano_contracts_enabled === 'feature_activation',
    minWeight: data.min_weight,
    minTxWeight: data.min_tx_weight,
    minTxWeightCoefficient: data.min_tx_weight_coefficient,
    minTxWeightK: data.min_tx_weight_k,
    tokenDepositPercentage: data.token_deposit_percentage,
    rewardSpendMinBlocks: data.reward_spend_min_blocks,
    maxNumberInputs: data.max_number_inputs,
    maxNumberOutputs: data.max_number_outputs,
    decimalPlaces: data.decimal_places ?? constants.DECIMAL_PLACES,
    nativeTokenName: data.native_token?.name ?? constants.DEFAULT_NATIVE_TOKEN_CONFIG.name,
    nativeTokenSymbol: data.native_token?.symbol ?? constants.DEFAULT_NATIVE_TOKEN_CONFIG.symbol,
  };
}

/**
 * Gets the converted fullnode version data.
 * Will get from database if the cached version data is valid.
 */
export async function getFullnodeData(mysql: ServerlessMysql): Promise<FullNodeVersionData> {
  const data = await getRawFullnodeData(mysql);
  return convertApiVersionData(data);
}
