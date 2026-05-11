import fullnode from '@src/fullnode';
import { FullNodeApiVersionResponse } from '@src/types';

const VALID_VERSION_PAYLOAD: FullNodeApiVersionResponse = {
  version: '0.70.0-rc.1',
  network: 'testnet-india',
  nano_contracts_enabled: true,
  min_weight: 8,
  min_tx_weight: 8,
  min_tx_weight_coefficient: 0,
  min_tx_weight_k: 0,
  token_deposit_percentage: 0.01,
  reward_spend_min_blocks: 300,
  max_number_inputs: 255,
  max_number_outputs: 255,
  decimal_places: 2,
  genesis_block_hash: '000001b7d5abc44d3828529654e8d830eeca1cd0e313032be1b8e9dfe31052ee',
  genesis_tx1_hash: '00768e4df506979bb14e0efc16748d9306fa176de54e86069d115e74b26957df',
  genesis_tx2_hash: '00306abcedddfa21707e7920fe324a997e3a311a959a18724c7e8cfd0468c164',
  native_token: { name: 'Hathor', symbol: 'HTR', version: 0 },
};

test('version returns parsed payload when the response matches the schema', async () => {
  expect.hasAssertions();

  const apiGetSpy = jest.spyOn(fullnode.api, 'get');
  apiGetSpy.mockImplementation(() => Promise.resolve({
    status: 200,
    data: VALID_VERSION_PAYLOAD,
  }));

  const response = await fullnode.version();
  expect(response).toStrictEqual(VALID_VERSION_PAYLOAD);
});

test('version throws when the response fails schema validation', async () => {
  expect.hasAssertions();

  const invalidPayload = {
    ...VALID_VERSION_PAYLOAD,
    native_token: { name: 'Hathor', symbol: 'HTR', version: 1.5 },
  };
  const apiGetSpy = jest.spyOn(fullnode.api, 'get');
  apiGetSpy.mockImplementation(() => Promise.resolve({
    status: 200,
    data: invalidPayload,
  }));

  await expect(fullnode.version()).rejects.toThrow(/native_token\.version/);
});

test('downloadTx', async () => {
  expect.hasAssertions();

  const mockData = {
    success: true,
    tx: {
      hash: 'tx1',
    },
    meta: {},
  };

  const apiGetSpy = jest.spyOn(fullnode.api, 'get');
  apiGetSpy.mockImplementation(() => Promise.resolve({
    status: 200,
    data: mockData,
  }));

  const response = await fullnode.downloadTx('tx1');
  expect(response).toStrictEqual(mockData);
});

test('getConfirmationData', async () => {
  expect.hasAssertions();

  const mockData = {
    success: true,
    accumulated_weight: 67.45956109191802,
    accumulated_bigger: true,
    stop_value: 67.45416781056525,
    confirmation_level: 1,
  };

  const apiGetSpy = jest.spyOn(fullnode.api, 'get');
  apiGetSpy.mockImplementation(() => Promise.resolve({
    status: 200,
    data: mockData,
  }));

  const response = await fullnode.getConfirmationData('tx1');
  expect(response).toStrictEqual(mockData);
});

test('queryGraphvizNeighbours', async () => {
  expect.hasAssertions();

  const mockData = 'diagraph {}';

  const apiGetSpy = jest.spyOn(fullnode.api, 'get');
  apiGetSpy.mockImplementation(() => Promise.resolve({
    status: 200,
    data: mockData,
  }));

  const response = await fullnode.queryGraphvizNeighbours('tx1', 'test', 1);
  expect(response).toStrictEqual(mockData);
});
