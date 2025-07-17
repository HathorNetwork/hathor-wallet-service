import HealthCheckActor from '../../src/actors/HealthCheckActor';
import axios from 'axios';
import logger from '../../src/logger';
import { EventTypes } from '../../src/types/event';
import getConfig from '../../src/config';

jest.useFakeTimers();
jest.spyOn(global, 'setInterval');
jest.spyOn(global, 'clearInterval');

describe('HealthCheckActor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    it('should not start pinging on initialization', () => {
        const config = getConfig();

        config['HEALTHCHECK_ENABLED'] = true;

        // Mock axios and logger
        const mockAxios = jest.spyOn(axios, 'post');
        const mockLogger = jest.spyOn(logger, 'info');

        // Mock the callback and receive functions
        const mockCallback = jest.fn();

        let receiveCallback: any;

        const mockReceive = jest.fn().mockImplementation((callback) => {
            receiveCallback = callback;
        });

        // Call the HealthCheckActor function
        HealthCheckActor(mockCallback, mockReceive, config);

        expect(setInterval).not.toHaveBeenCalled();
    });

    it('should start pinging when receiving a START event and stop when receiving a STOP event', () => {
        const config = getConfig();

        config['HEALTHCHECK_ENABLED'] = true;
        config['HEALTHCHECK_SERVER_URL'] = 'http://localhost:3000';

        // Mock axios and logger
        const mockAxios = jest.spyOn(axios, 'post');
        const mockLogger = jest.spyOn(logger, 'info');

        // Mock the callback and receive functions
        const mockCallback = jest.fn();

        let receiveCallback: any;

        const mockReceive = jest.fn().mockImplementation((callback) => {
            receiveCallback = callback;
        });

        // Call the HealthCheckActor function
        HealthCheckActor(mockCallback, mockReceive, config);

        // Call the receive callback with a START event
        receiveCallback({
            type: EventTypes.HEALTHCHECK_EVENT,
            event: {
                type: 'START',
            },
        });

        expect(setInterval).toHaveBeenCalledTimes(1);

        // Call the receive callback with a STOP event
        receiveCallback({
            type: EventTypes.HEALTHCHECK_EVENT,
            event: {
                type: 'STOP',
            },
        });

        expect(clearInterval).toHaveBeenCalledTimes(1);
    });

    it('should stop pinging when the actor is stopped', () => {
        const config = getConfig();
        config['HEALTHCHECK_ENABLED'] = true;
        config['HEALTHCHECK_SERVER_URL'] = 'http://localhost:3000';

        // Mock axios and logger
        const mockAxios = jest.spyOn(axios, 'post');
        const mockLogger = jest.spyOn(logger, 'info');

        // Mock the callback and receive functions
        const mockCallback = jest.fn();

        let receiveCallback: any;

        const mockReceive = jest.fn().mockImplementation((callback) => {
            receiveCallback = callback;
        });

        // Call the HealthCheckActor function
        const stopHealthCheckActor = HealthCheckActor(mockCallback, mockReceive, config);

        // Call the receive callback with a START event
        receiveCallback({
            type: EventTypes.HEALTHCHECK_EVENT,
            event: {
                type: 'START',
            },
        });

        expect(setInterval).toHaveBeenCalledTimes(1);

        // Call the stop function
        stopHealthCheckActor();

        expect(clearInterval).toHaveBeenCalledTimes(1);
    });

    it('should not start pinging when HEALTHCHECK_ENABLED is false', () => {
        const config = getConfig();
        config['HEALTHCHECK_ENABLED'] = false;

        // Mock axios and logger
        const mockAxios = jest.spyOn(axios, 'post');
        const mockLogger = jest.spyOn(logger, 'info');

        // Mock the callback and receive functions
        const mockCallback = jest.fn();

        let receiveCallback: any;

        const mockReceive = jest.fn().mockImplementation((callback) => {
            receiveCallback = callback;
        });

        // Call the HealthCheckActor function
        HealthCheckActor(mockCallback, mockReceive, config);

        expect(mockReceive).not.toHaveBeenCalled();
    });

    it('should send ping after the configured interval', () => {
        const config = getConfig();
        config['HEALTHCHECK_ENABLED'] = true;
        config['HEALTHCHECK_SERVER_URL'] = 'http://localhost:3000';
        config['HEALTHCHECK_SERVER_API_KEY'] = 'test-api-key';

        // Mock axios and logger
        const mockAxios = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200 });
        const mockLogger = jest.spyOn(logger, 'info');

        // Mock the callback and receive functions
        const mockCallback = jest.fn();

        let receiveCallback: any;

        const mockReceive = jest.fn().mockImplementation((callback) => {
            receiveCallback = callback;
        });

        // Call the HealthCheckActor function
        HealthCheckActor(mockCallback, mockReceive, config);

        // Call the receive callback with a START event
        receiveCallback({
            type: EventTypes.HEALTHCHECK_EVENT,
            event: {
                type: 'START',
            },
        });

        expect(setInterval).toHaveBeenCalledTimes(1);

        // Fast-forward until all timers have been executed
        jest.runOnlyPendingTimers();

        expect(mockAxios).toHaveBeenCalledTimes(1);
        expect(mockAxios).toHaveBeenCalledWith(
            'http://localhost:3000',
            {},
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': 'test-api-key',
                },
            },
        );
    });
});
