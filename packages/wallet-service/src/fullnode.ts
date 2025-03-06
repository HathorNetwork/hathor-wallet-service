/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import axios from 'axios';
import Joi from 'joi';
import config from '@src/config';

export const BASE_URL = config.defaultServer;
export const TIMEOUT = 10000;

/**
 * Fullnode API response.
 */
interface FullnodeApiVersionResponse {
  version: string;
  network: string;
  min_weight: number;
  min_tx_weight: number;
  min_tx_weight_coefficient: number; // float
  min_tx_weight_k: number;
  token_deposit_percentage: number; // float
  reward_spend_min_blocks: number;
  max_number_inputs: number;
  max_number_outputs: number;
  decimal_places: number;
  genesis_block_hash: string,
  genesis_tx1_hash: string,
  genesis_tx2_hash: string,
  native_token: { name: string, symbol: string};
}

const FullnodeVersionSchema = Joi.object<FullnodeApiVersionResponse>({
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
})

/**
 * Creates a handler for requesting data from the fullnode
 *
 * @param baseURL - The base URL for the full-node. Defaults to `env.DEFAULT_SERVER`
 */
export const create = (baseURL = BASE_URL) => {
  const api = axios.create({
    baseURL,
    headers: {},
    timeout: TIMEOUT,
  });

  const version = async (): Promise<FullnodeApiVersionResponse> => {
    const response = await api.get('version', {
      data: null,
      headers: { 'content-type': 'application/json' },
    });
    const { value, error } = FullnodeVersionSchema.validate(response.data);
    if (error) {
      throw new Error(error.message);
    }

    return value as FullnodeApiVersionResponse;
  };

  const downloadTx = async (txId: string) => {
    const response = await api.get(`transaction?id=${txId}`, {
      data: null,
      headers: { 'content-type': 'application/json' },
    });

    return response.data;
  };

  const getConfirmationData = async (txId: string) => {
    const response = await api.get(`transaction_acc_weight?id=${txId}`, {
      data: null,
      headers: { 'content-type': 'application/json' },
    });

    return response.data;
  };

  const queryGraphvizNeighbours = async (
    txId: string,
    graphType: string,
    maxLevel: number,
  ) => {
    const url = `graphviz/neighbours.dot/?tx=${txId}&graph_type=${graphType}&max_level=${maxLevel}`;
    const response = await api.get(url, {
      data: null,
      headers: { 'content-type': 'application/json' },
    });

    return response.data;
  };

  const getStatus = async () => {
    const response = await api.get('status', {
      data: null,
      headers: { 'content-type': 'application/json' },
    });

    return response.data;
  }

  const getHealth = async () => {
    const response = await api.get('health', {
      data: null,
      headers: { 'content-type': 'application/json' },
    });

    return response.data;
  }

  return {
    api, // exported so we can mock it on the tests
    version,
    downloadTx,
    getConfirmationData,
    queryGraphvizNeighbours,
    getStatus,
    getHealth
  };
};

export default create();
