import { FullnodeVersionSchema } from '@src/schemas';
import { defaultTestVersionData } from '@tests/utils';

// Regression guard: the `native_token.version` is not available in all live fullnode instances.
// The Wallet Service must be able to handle both cases.
test('FullnodeVersionSchema regression: native_token.version is accepted', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 0 },
  };
  const { error, value } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeUndefined();
  expect(value.native_token).toEqual({ name: 'Hathor', symbol: 'HTR', version: 0 });
});

test('FullnodeVersionSchema accepts a legacy fullnode payload without native_token.version', () => {
  // defaultTestVersionData() returns a payload whose native_token has no `version`.
  const { error } = FullnodeVersionSchema.validate(defaultTestVersionData());
  expect(error).toBeUndefined();
});

// Design-intent guard: native_token is intentionally strict — any unknown
// field there fails validation so a contract test (and not a production
// outage) surfaces fullnode schema drift.
test('FullnodeVersionSchema rejects unknown fields under native_token', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 0, icon: 'data:image/png;base64,...' },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.icon/);
});

test('FullnodeVersionSchema rejects a non-integer native_token.version', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 1.5 },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.version/);
});

test('FullnodeVersionSchema accepts the token deposit percentage numerator/denominator', () => {
  const payload = {
    ...defaultTestVersionData(),
    token_deposit_percentage_numerator: 10000000,
    token_deposit_percentage_denominator: 1000000000,
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeUndefined();
});

test('FullnodeVersionSchema rejects a non-integer token_deposit_percentage_numerator', () => {
  const payload = {
    ...defaultTestVersionData(),
    token_deposit_percentage_numerator: 1.5,
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/token_deposit_percentage_numerator/);
});
