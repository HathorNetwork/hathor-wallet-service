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

const mysql = getDbConnection();

const HEALTHCHECK_MAXIMUM_HEIGHT_DIFFERENCE = Number(process.env.HEALTHCHECK_MAXIMUM_HEIGHT_DIFFERENCE) || 5;

const checkDatabaseHeight: HealthcheckCallbackResponse = async () => {
    try {
        const [currentHeight, fullnodeStatus] = await Promise.all([
            getLatestHeight(mysql),
            fullnode.getStatus()
        ]);

        const currentFullnodeHeight = fullnodeStatus['dag']['best_block']['height'];

        if (currentFullnodeHeight - currentHeight < HEALTHCHECK_MAXIMUM_HEIGHT_DIFFERENCE) {
            return new HealthcheckCallbackResponse({
                status: HealthcheckStatus.PASS,
                output: `Database and fullnode heaights are within ${HEALTHCHECK_MAXIMUM_HEIGHT_DIFFERENCE} blocks difference`,
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

    // Register components
    healthcheck.add_component(heightHealthcheck);
    healthcheck.add_component(redisHealthcheck);
    healthcheck.add_component(fullnodeHealthcheck);

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
});