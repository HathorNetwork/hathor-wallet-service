/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import axios from 'axios';
import logger from '../logger';
import getConfig from '../config';
import { Event, EventTypes } from '../types';

const sendPing = async () => {
  const { HEALTHCHECK_SERVER_URL, HEALTHCHECK_SERVER_API_KEY } = getConfig();

  if (!HEALTHCHECK_SERVER_URL) {
    logger.warning('Health-monitor server URL not set. Skipping ping');
    return;
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': HEALTHCHECK_SERVER_API_KEY
    };
    // TODO Get this URL from params/config
    const response = await axios.post(
      HEALTHCHECK_SERVER_URL,
      {},
      { headers }
    );

    if (response.status > 399) {
      logger.warning(`Health-monitor returned status ${response.status}`);
    }
  } catch (err) {
    logger.warning(`Error sending ping to health-monitor: ${err}`);
  }
}

export default (callback: any, receive: any) => {
  const { HEALTHCHECK_ENABLED, HEALTHCHECK_PING_INTERVAL } = getConfig();

  if (!HEALTHCHECK_ENABLED) {
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
      await sendPing();
    }, HEALTHCHECK_PING_INTERVAL);
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
