import middy from '@middy/core';
import {
  Healthcheck,
  HealthcheckInternalComponent,
  HealthcheckDatastoreComponent,
  HealthcheckHTTPComponent,
  HealthcheckCallbackResponse,
  HealthcheckStatus,
} from '@hathor/healthcheck-lib';
import { getLatestHeight } from '@src/db';
import fullnode from '@src/fullnode';
import { closeDbConnection, getDbConnection } from '@src/utils';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { getRedisClient, ping } from '@src/redis';
import config from '@src/config';
import errorHandler from '@src/api/middlewares/errorHandler';
import { isShieldedCryptoProviderRegistered } from '@wallet-service/common';
import { ensureShieldedCryptoProvider, shieldedCryptoLoadError } from '@src/shieldedCrypto';
import createDefaultLogger from '@src/logger';

const mysql = getDbConnection();

const checkDatabaseHeight: HealthcheckCallbackResponse = async () => {
  try {
    const [currentHeight, fullnodeStatus] = await Promise.all([
      getLatestHeight(mysql),
      fullnode.getStatus()
    ]);

    const currentFullnodeHeight = fullnodeStatus['dag']['best_block']['height'];

    if (currentFullnodeHeight - currentHeight < config.healthCheckMaximumHeightDifference) {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.PASS,
        output: `Database and fullnode heights are within ${config.healthCheckMaximumHeightDifference} blocks difference`,
      });
    } else {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.FAIL,
        output: `Database height is ${currentHeight} but fullnode height is ${currentFullnodeHeight}`,
      });
    }
  } catch (e) {
    console.error(e);

    return new HealthcheckCallbackResponse({
      status: HealthcheckStatus.FAIL,
      output: `Error checking database and fullnode height: ${e.message}`,
    });
  }
};

const checkRedisConnection: HealthcheckCallbackResponse = async () => {
  const client = getRedisClient();
  try {
    const pingResult = await ping(client);

    if (pingResult === 'PONG') {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.PASS,
        output: `Redis connection is up`,
      });
    } else {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.FAIL,
        output: `Redis responded ping with invalid response: ${pingResult}`,
      });
    }
  } catch (e) {
    console.error(e);

    return new HealthcheckCallbackResponse({
      status: HealthcheckStatus.FAIL,
      output: `Error checking redis connection: ${e.message}`,
    });
  }
};

const checkFullnodeHealth: HealthcheckCallbackResponse = async () => {
  try {
    const health = await fullnode.getHealth();

    if (health['status'] === HealthcheckStatus.PASS) {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.PASS,
        output: `Fullnode is healthy`,
      });
    } else if (health['status'] === HealthcheckStatus.WARN) {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.WARN,
        output: `Fullnode has health warnings: ${health}`,
      });
    } else {
      return new HealthcheckCallbackResponse({
        status: HealthcheckStatus.FAIL,
        output: `Fullnode is unhealthy: ${JSON.stringify(health)}`,
      });
    }
  } catch (e) {
    console.error(e);

    return new HealthcheckCallbackResponse({
      status: HealthcheckStatus.FAIL,
      output: `Error checking fullnode health: ${e.message}`,
    });
  }
};

/**
 * Whether this artifact can recover shielded outputs. Loads the provider the
 * same way the recovery sweep does, so a binary missing from the package, or
 * built for another platform, fails here rather than silently per output.
 */
const checkShieldedCryptoProvider: HealthcheckCallbackResponse = async () => {
  await ensureShieldedCryptoProvider(createDefaultLogger());
  if (isShieldedCryptoProviderRegistered()) {
    return new HealthcheckCallbackResponse({
      status: HealthcheckStatus.PASS,
      output: 'Shielded crypto provider is registered',
    });
  }
  return new HealthcheckCallbackResponse({
    status: HealthcheckStatus.FAIL,
    output: `Shielded crypto provider failed to load: ${shieldedCryptoLoadError() ?? 'not registered'}`,
  });
};

const setupHealthcheck: Healthcheck = () => {
  const healthcheck = new Healthcheck({ name: 'hathor-wallet-service', warnIsUnhealthy: true });

  // Height healthcheck component
  const heightHealthcheck = new HealthcheckInternalComponent({
    name: 'mysql:block_height',
  });
  heightHealthcheck.add_healthcheck(checkDatabaseHeight);

  // Redis healthcheck component
  const redisHealthcheck = new HealthcheckDatastoreComponent({
    name: 'redis:connection',
  });
  redisHealthcheck.add_healthcheck(checkRedisConnection);

  // Fullnode healthcheck component
  const fullnodeHealthcheck = new HealthcheckHTTPComponent({
    name: 'fullnode:health',
  });
  fullnodeHealthcheck.add_healthcheck(checkFullnodeHealth);

  // Shielded crypto provider healthcheck component
  const shieldedCryptoHealthcheck = new HealthcheckInternalComponent({
    name: 'shielded:crypto_provider',
  });
  shieldedCryptoHealthcheck.add_healthcheck(checkShieldedCryptoProvider);

  // Register components
  healthcheck.add_component(heightHealthcheck);
  healthcheck.add_component(redisHealthcheck);
  healthcheck.add_component(fullnodeHealthcheck);
  healthcheck.add_component(shieldedCryptoHealthcheck);

  return healthcheck;
};

export const getHealthcheck: APIGatewayProxyHandler = middy(async (event) => {
  const healthcheck = setupHealthcheck();
  const response = await healthcheck.run();

  await closeDbConnection(mysql);

  return {
    statusCode: response.getHttpStatusCode(),
    body: response.toJson(),
  };
}).use(errorHandler());
