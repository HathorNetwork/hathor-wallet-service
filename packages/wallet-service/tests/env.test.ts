import config, { loadEnvConfig } from '@src/config';

test('Configuration should load correctly during tests', () => {
  expect.hasAssertions();

  // Access config so the proxy loads the config from the environment variables.
  expect(config.stage).toBe('local');
  const loadedConfig = loadEnvConfig();

  console.log(loadedConfig);
  console.log(config);
  expect(loadedConfig).toStrictEqual(config);

  expect(config.confirmFirstAddress).toEqual(true);
});

test('loadEnvConfig should get the config from the env', () => {
  expect.hasAssertions();

  const oldNetwork = process.env.NETWORK;
  process.env.NETWORK = 'unknown unexisting network';

  try {
    const loadedConfig = loadEnvConfig();
    expect(loadedConfig.network).toEqual('unknown unexisting network');
  } finally {
    process.env.NETWORK = oldNetwork;
  }

});
