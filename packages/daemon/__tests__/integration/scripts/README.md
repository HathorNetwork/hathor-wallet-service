# Integration Test Scripts

This directory contains scripts and utilities for running integration tests.

## WebSocket Proxy Simulator

The `ws-proxy-simulator.ts` is a WebSocket proxy that sits between the daemon and a fullnode simulator. It allows you to intercept and manipulate messages for testing purposes.

### Features

- **ACK Delay**: Add delays to ACK messages to simulate network latency
- **ACK Dropping**: Randomly drop ACK messages to test packet loss scenarios
- **Event Buffering**: Buffer events and send them after ACK is processed
- **Statistics**: Track relayed events, ACKs received, delayed, and dropped

### Usage

#### Programmatic (in tests)

See `ack-timeout.test.ts` for examples of using the proxy in integration tests.

#### Manual/Command Line

```bash
# Start the proxy with no modifications (pass-through mode)
UPSTREAM_PORT=8087 ts-node ws-proxy-simulator.ts

# Add 5-second delay to all ACKs
ACK_DELAY_MS=5000 UPSTREAM_PORT=8087 ts-node ws-proxy-simulator.ts

# Drop 30% of ACKs randomly
DROP_ACK_PROBABILITY=0.3 UPSTREAM_PORT=8087 ts-node ws-proxy-simulator.ts

# Combine: delay ACKs by 3 seconds and drop 10%
ACK_DELAY_MS=3000 DROP_ACK_PROBABILITY=0.1 UPSTREAM_PORT=8087 ts-node ws-proxy-simulator.ts

# Buffer events and send after ACK delay
BUFFER_EVENTS=true ACK_DELAY_MS=2000 UPSTREAM_PORT=8087 ts-node ws-proxy-simulator.ts
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROXY_PORT` | Port to listen on | `8080` |
| `UPSTREAM_HOST` | Upstream simulator host | `localhost` |
| `UPSTREAM_PORT` | Upstream simulator port | **Required** |
| `ACK_DELAY_MS` | Milliseconds to delay ACKs | `0` |
| `DROP_ACK_PROBABILITY` | Probability (0-1) to drop ACKs | `0` |
| `BUFFER_EVENTS` | Buffer events until after ACK | `false` |

### Testing Scenarios

#### Test ACK Timeout Detection

```bash
# Terminal 1: Start upstream simulator (via docker-compose)
cd packages/daemon/__tests__/integration/scripts
docker compose up empty_script

# Terminal 2: Start proxy with 30-second ACK delay
ACK_DELAY_MS=30000 UPSTREAM_PORT=8087 PROXY_PORT=9000 ts-node ws-proxy-simulator.ts

# Terminal 3: Run daemon pointing to proxy
# Configure daemon to connect to localhost:9000 with ACK_TIMEOUT_MS=5000
# The daemon should detect missed events after 5 seconds of no ACK
```

#### Test Packet Loss Recovery

```bash
# Start proxy with 50% packet loss
DROP_ACK_PROBABILITY=0.5 UPSTREAM_PORT=8087 PROXY_PORT=9000 ts-node ws-proxy-simulator.ts

# Run daemon and observe how it handles missing ACKs
```

### Architecture

```
┌────────┐          ┌───────────────┐          ┌──────────────┐
│ Daemon │ <------> │ Proxy Server  │ <------> │ Fullnode Sim │
└────────┘   WS     └───────────────┘   WS     └──────────────┘
             ACKs    Intercepts ACKs           Events
             Events  Relays Events
```

The proxy:
1. Receives events from the upstream fullnode simulator
2. Relays them to the daemon client
3. Intercepts ACK messages from the daemon
4. Applies configured delays/drops to ACKs
5. Forwards ACKs to upstream simulator

### Implementation Details

- Built with Node.js `ws` library
- Supports JSON message inspection
- Graceful shutdown on SIGTERM/SIGINT
- Detailed logging of all intercepted messages
- Connection statistics per client

### Integration with Tests

The `ack-timeout.test.ts` file demonstrates how to:
- Start the proxy programmatically
- Configure different test scenarios
- Verify timeout behavior
- Clean up proxy processes after tests
