import fullnode from '@src/fullnode';
import { defaultTestVersionData } from '@tests/utils';

describe('version', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns parsed payload when native_token includes the version field', async () => {
    expect.hasAssertions();

    const payload = {
      ...defaultTestVersionData(),
      native_token: { name: 'Hathor', symbol: 'HTR', version: 0 },
    };
    const apiGetSpy = jest.spyOn(fullnode.api, 'get');
    apiGetSpy.mockImplementation(() => Promise.resolve({
      status: 200,
      data: payload,
    }));

    const response = await fullnode.version();
    expect(response).toStrictEqual(payload);
  });

  test('returns parsed payload when native_token omits the version field', async () => {
    expect.hasAssertions();

    // defaultTestVersionData() returns a payload whose native_token has no `version`.
    const payload = defaultTestVersionData();
    const apiGetSpy = jest.spyOn(fullnode.api, 'get');
    apiGetSpy.mockImplementation(() => Promise.resolve({
      status: 200,
      data: payload,
    }));

    const response = await fullnode.version();
    expect(response).toStrictEqual(payload);
    expect(response.native_token).not.toHaveProperty('version');
  });

  test('throws when the response fails schema validation', async () => {
    expect.hasAssertions();

    const invalidPayload = {
      ...defaultTestVersionData(),
      native_token: { name: 'Hathor', symbol: 'HTR', version: 1.5 },
    };
    const apiGetSpy = jest.spyOn(fullnode.api, 'get');
    apiGetSpy.mockImplementation(() => Promise.resolve({
      status: 200,
      data: invalidPayload,
    }));

    await expect(fullnode.version()).rejects.toThrow(/native_token\.version/);
  });
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
