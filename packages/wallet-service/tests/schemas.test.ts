import { FullnodeVersionSchema } from '@src/schemas';
import { FullNodeApiVersionResponse } from '@src/types';

const VALID_PAYLOAD: FullNodeApiVersionResponse = {
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
  native_token: {
    name: 'Hathor',
    symbol: 'HTR',
    version: 0,
  },
};

// Regression guard for the testnet outage that motivated PR 420: the
// fullnode added `native_token.version` and the lambda crashed because the
// nested object did not allow it. Locking the modern payload in as a
// passing case prevents that fix from being reverted by accident.
test('FullnodeVersionSchema regression: PR 420 testnet payload validates', () => {
  const { error, value } = FullnodeVersionSchema.validate(VALID_PAYLOAD);
  expect(error).toBeUndefined();
  expect(value.native_token).toEqual({ name: 'Hathor', symbol: 'HTR', version: 0 });
});

test('FullnodeVersionSchema accepts a legacy fullnode payload without native_token.version', () => {
  const { native_token, ...rest } = VALID_PAYLOAD;
  const legacy = { ...rest, native_token: { name: native_token!.name, symbol: native_token!.symbol } };
  const { error } = FullnodeVersionSchema.validate(legacy);
  expect(error).toBeUndefined();
});

// Design-intent guard: native_token is intentionally strict — any unknown
// field there fails validation so a contract test (and not a production
// outage) surfaces fullnode schema drift.
test('FullnodeVersionSchema rejects unknown fields under native_token', () => {
  const payload = {
    ...VALID_PAYLOAD,
    native_token: { ...VALID_PAYLOAD.native_token, icon: 'data:image/png;base64,...' },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.icon/);
});

test('FullnodeVersionSchema rejects a non-integer native_token.version', () => {
  const payload = {
    ...VALID_PAYLOAD,
    native_token: { name: 'Hathor', symbol: 'HTR', version: 1.5 },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.version/);
});
