/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Joi from 'joi';
import { FullNodeApiVersionResponse, EnvironmentConfig } from '@src/types';

export const Sha256Schema = Joi.string().hex().length(64);

export const FullnodeVersionSchema = Joi.object<FullNodeApiVersionResponse>({
  version: Joi.string().min(1).required(),
  network: Joi.string().min(1).required(),
  min_weight: Joi.number().integer().required(),
  min_tx_weight: Joi.number().integer().required(),
  min_tx_weight_coefficient: Joi.number().required(),
  min_tx_weight_k: Joi.number().integer().required(),
  token_deposit_percentage: Joi.number().positive().required(),
  reward_spend_min_blocks: Joi.number().integer().positive().required(),
  max_number_inputs: Joi.number().integer().positive().required(),
  max_number_outputs: Joi.number().integer().positive().required(),
  decimal_places: Joi.number().integer().positive(),
  genesis_block_hash: Sha256Schema,
  genesis_tx1_hash: Sha256Schema,
  genesis_tx2_hash: Sha256Schema,
  native_token: Joi.object({
    name: Joi.string().min(1).max(30).required(),
    symbol: Joi.string().min(1).max(5).required(),
  }),
}).unknown(true);

export const EnvironmentConfigSchema = Joi.object<EnvironmentConfig>({
  defaultServer: Joi.string().required(),
  stage: Joi.string().required(),
  network: Joi.string().required(),
  serviceName: Joi.string().required(),
  maxAddressGap: Joi.number().required(),
  voidedTxOffset: Joi.number().required(),
  confirmFirstAddress: Joi.boolean().required(),
  wsDomain: Joi.string().required(),
  dbEndpoint: Joi.string().required(),
  dbName: Joi.string().required(),
  dbUser: Joi.string().required(),
  dbPass: Joi.string().required(),
  dbPort: Joi.number().required(),
  redisUrl: Joi.string().required(),
  redisPassword: Joi.string().allow(''),
  authSecret: Joi.string().required(),
  walletServiceLambdaEndpoint: Joi.string().required(),
  pushNotificationEnabled: Joi.boolean().required(),
  pushAllowedProviders: Joi.string().required(),
  isOffline: Joi.boolean().required(),
  txHistoryMaxCount: Joi.number().required(),
  healthCheckMaximumHeightDifference: Joi.number().required(),
  awsRegion: Joi.string().required(),

  firebaseProjectId: Joi.string().optional(),
  firebasePrivateKeyId: Joi.string().optional(),
  firebaseClientEmail: Joi.string().optional(),
  firebaseClientId: Joi.string().optional(),
  firebaseAuthUri: Joi.string().optional(),
  firebaseTokenUri: Joi.string().optional(),
  firebaseAuthProviderX509CertUrl: Joi.string().optional(),
  firebaseClientX509CertUrl: Joi.string().optional(),
  firebasePrivateKey: Joi.string().allow(null).optional(),

  maxLoadWalletRetries: Joi.number().required(),
  logLevel: Joi.string().required(),
  createNftMaxRetries: Joi.number().required(),
  warnMaxReorgSize: Joi.number().required(),
});
