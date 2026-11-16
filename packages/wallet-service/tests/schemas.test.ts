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

// Forward-compat: the deprecated float is optional as long as the integer fraction is present.
test('FullnodeVersionSchema accepts a payload that omits the deprecated token_deposit_percentage when the fraction is present', () => {
  const payload = {
    ...defaultTestVersionData(),
    token_deposit_percentage_numerator: 10000000,
    token_deposit_percentage_denominator: 1000000000,
  };
  delete (payload as { token_deposit_percentage?: number }).token_deposit_percentage;
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeUndefined();
});

// A response with no deposit-percentage source at all would silently fall back to a
// compiled-in default downstream, so reject it instead.
test('FullnodeVersionSchema rejects a payload that omits all deposit percentage fields', () => {
  const payload = defaultTestVersionData();
  delete (payload as { token_deposit_percentage?: number }).token_deposit_percentage;
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/token_deposit_percentage/);
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

// The fraction is only usable as a complete pair; a half-populated fraction would be
// ignored downstream and silently fall back to the default, so reject it.
test('FullnodeVersionSchema rejects a numerator without a denominator', () => {
  const payload = {
    ...defaultTestVersionData(),
    token_deposit_percentage_numerator: 10000000,
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/token_deposit_percentage_denominator/);
});

test('FullnodeVersionSchema rejects a denominator without a numerator', () => {
  const payload = {
    ...defaultTestVersionData(),
    token_deposit_percentage_denominator: 1000000000,
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/token_deposit_percentage_numerator/);
});
