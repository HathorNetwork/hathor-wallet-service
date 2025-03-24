/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Import the CommonJS version of axios directly
import axios from 'axios/dist/node/axios.cjs';
import logger from '../logger';
import getConfig from '../config';
import { Event, EventTypes } from '../types';

/**
 * Send a ping to the health-monitor server
**/
const sendPing = async (config = getConfig()) => {
  if (!config.HEALTHCHECK_SERVER_URL) {
    logger.warn('Health-monitor server URL not set. Skipping ping');
    return;
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': config.HEALTHCHECK_SERVER_API_KEY
    };
    const response = await axios.post(
      config.HEALTHCHECK_SERVER_URL,
      {},
      { headers }
    );

    if (response.status > 399) {
      logger.warn(`Health-monitor returned status ${response.status}`);
    }
  } catch (err) {
    logger.warn(`Error sending ping to health-monitor: ${err}`);
  }
}

/**
 * HealthCheckActor
 *
 * This actor is responsible for controlling the healthcheck ping to the health-monitor server
 * It will send a ping every HEALTHCHECK_PING_INTERVAL, if the feature is enabled.
 *
 * In case an event of type HEALTHCHECK_EVENT is received, it will start or stop the ping,
 * depending on the event content.
 *
 * The events are received from the SyncMachine. When the SyncMachine connects to the
 * full node, it will send a HEALTHCHECK_EVENT with type START, and when it disconnects or errors, it will
 * send a HEALTHCHECK_EVENT with type STOP.
 *
 * This description could get outdated, so please check the machine code for the latest implementation.
 *
 **/
export default (callback: any, receive: any, config = getConfig()) => {
  if (!config.HEALTHCHECK_ENABLED) {
    logger.info('Healthcheck feature is disabled. Not starting healthcheck actor');

    return () => {};
  }

  logger.info('Starting healthcheck actor');

  let pingTimer: NodeJS.Timer | null = null;

  const createPingTimer = () => {
    if (pingTimer) {
      clearPingTimer();
    }

    pingTimer = setInterval(async () => {
      logger.info('Sending ping to health-monitor server');
      await sendPing(config);
    }, config.HEALTHCHECK_PING_INTERVAL);
  };

  const clearPingTimer = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  receive((event: Event) => {
    if (event.type !== EventTypes.HEALTHCHECK_EVENT) {
      logger.warn('Event of a different type than HEALTHCHECK_EVENT reached the healthcheck actor');

      return;
    }

    if (event.event.type === 'STOP') {
      logger.info('Stopping healthcheck ping');
      clearPingTimer();
    }

    if (event.event.type === 'START') {
      logger.info('Starting healthcheck ping');
      createPingTimer();
    }
  });

  // Clear the interval when the actor is stopped just to be sure
  return () => {
    logger.info('Stopping healthcheck actor');
    clearPingTimer();
  };
};
