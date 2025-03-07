/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Joi from 'joi';
import { FullNodeApiVersionResponse, EnvironmentConfig } from '@src/types';

export const FullnodeVersionSchema = Joi.object<FullNodeApiVersionResponse>({
  version: Joi.string().min(1).required(),
  network: Joi.string().min(1).required(),
  min_weight: Joi.number().integer().positive().required(),
  min_tx_weight: Joi.number().integer().positive().required(),
  min_tx_weight_coefficient: Joi.number().positive().required(),
  min_tx_weight_k: Joi.number().integer().positive().required(),
  token_deposit_percentage: Joi.number().positive().required(),
  reward_spend_min_blocks: Joi.number().integer().positive().required(),
  max_number_inputs: Joi.number().integer().positive().required(),
  max_number_outputs: Joi.number().integer().positive().required(),
  decimal_places: Joi.number().integer().positive().required(),
  genesis_block_hash: Joi.string().min(1).required(),
  genesis_tx1_hash: Joi.string().hex().length(64).required(),
  genesis_tx2_hash: Joi.string().hex().length(64).required(),
  native_token: Joi.object({
    name: Joi.string().min(1).max(30).required(),
    symbol: Joi.string().min(1).max(5).required(),
  }),
});

export const EnvironmentConfigSchema = Joi.object<EnvironmentConfig>({
  defaultServer: Joi.string().required(),
  stage: Joi.string().required(),
  network: Joi.string().required(),
  serviceName: Joi.string().required(),
  maxAddressGap: Joi.number().required(),
  voidedTxOffset: Joi.number().required(),
  blockRewardLock: Joi.number().required(),
  confirmFirstAddress: Joi.boolean().required(),
  wsDomain: Joi.string().required(),
  dbEndpoint: Joi.string().required(),
  dbName: Joi.string().required(),
  dbUser: Joi.string().required(),
  dbPass: Joi.string().required(),
  redisHost: Joi.string().required(),
  redisPort: Joi.number().required(),
  authSecret: Joi.string().required(),
  explorerServiceLambdaEndpoint: Joi.string().required(),
  walletServiceLambdaEndpoint: Joi.string().required(),
  pushNotification: Joi.boolean().required(),
  pushAllowedProviders: Joi.string().required(),
});
