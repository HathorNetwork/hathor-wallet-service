import {
  closeDbConnection,
  getDbConnection,
  getUnixTimestamp,
} from '@src/utils';
import { addToVersionDataTable, cleanDatabase } from '@tests/utils';
import { FullNodeApiVersionResponse } from '@src/types';
import { convertApiVersionData, getRawFullnodeData } from '@src/nodeConfig';

const mysql = getDbConnection();

const VERSION_DATA: FullNodeApiVersionResponse = {
  version: "0.63.1",
  network: "mainnet",
  min_weight: 14,
  min_tx_weight: 14,
  min_tx_weight_coefficient: 1.6,
  min_tx_weight_k: 100,
  token_deposit_percentage: 0.01,
  reward_spend_min_blocks: 300,
  max_number_inputs: 255,
  max_number_outputs: 255,
  decimal_places: 2,
  genesis_block_hash: "000006cb93385b8b87a545a1cbb6197e6caff600c12cc12fc54250d39c8088fc",
  genesis_tx1_hash: "0002d4d2a15def7604688e1878ab681142a7b155cbe52a6b4e031250ae96db0a",
  genesis_tx2_hash: "0002ad8d1519daaddc8e1a37b14aac0b045129c01832281fb1c02d873c7abbf9",
  native_token: {
    name: "Hathor-new",
    symbol: "nHTR"
  }
};

const OLD_VERSION_DATA: FullNodeApiVersionResponse = {
  version: "0.63.1",
  network: "mainnet",
  min_weight: 14,
  min_tx_weight: 14,
  min_tx_weight_coefficient: 1.6,
  min_tx_weight_k: 100,
  token_deposit_percentage: 0.01,
  reward_spend_min_blocks: 300,
  max_number_inputs: 255,
  max_number_outputs: 255,
};

beforeEach(async () => {
  jest.resetModules();
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

test('getRawFullnodeData', async () => {
  const now = getUnixTimestamp();
  await addToVersionDataTable(mysql, now, VERSION_DATA);

  await expect(getRawFullnodeData(mysql)).resolves.toStrictEqual(VERSION_DATA);
});

test('convertApiVersionData', async () => {
  expect(convertApiVersionData(OLD_VERSION_DATA)).toStrictEqual({
    version: OLD_VERSION_DATA.version,
    network: OLD_VERSION_DATA.network,
    minWeight: OLD_VERSION_DATA.min_weight,
    minTxWeight: OLD_VERSION_DATA.min_tx_weight,
    minTxWeightCoefficient: OLD_VERSION_DATA.min_tx_weight_coefficient,
    minTxWeightK: OLD_VERSION_DATA.min_tx_weight_k,
    tokenDepositPercentage: OLD_VERSION_DATA.token_deposit_percentage,
    rewardSpendMinBlocks: OLD_VERSION_DATA.reward_spend_min_blocks,
    maxNumberInputs: OLD_VERSION_DATA.max_number_inputs,
    maxNumberOutputs: OLD_VERSION_DATA.max_number_outputs,
    decimalPlaces: 2,
    nativeTokenName: "Hathor",
    nativeTokenSymbol: "HTR",
  });

  expect(convertApiVersionData(VERSION_DATA)).toStrictEqual({
    version: VERSION_DATA.version,
    network: VERSION_DATA.network,
    minWeight: VERSION_DATA.min_weight,
    minTxWeight: VERSION_DATA.min_tx_weight,
    minTxWeightCoefficient: VERSION_DATA.min_tx_weight_coefficient,
    minTxWeightK: VERSION_DATA.min_tx_weight_k,
    tokenDepositPercentage: VERSION_DATA.token_deposit_percentage,
    rewardSpendMinBlocks: VERSION_DATA.reward_spend_min_blocks,
    maxNumberInputs: VERSION_DATA.max_number_inputs,
    maxNumberOutputs: VERSION_DATA.max_number_outputs,
    decimalPlaces: VERSION_DATA.decimal_places,
    nativeTokenName: VERSION_DATA.native_token.name,
    nativeTokenSymbol: VERSION_DATA.native_token.symbol,
  });
});
