/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * WebSocket Proxy Simulator
 *
 * This proxy sits between the daemon and the actual fullnode simulator,
 * allowing us to intercept and manipulate WebSocket messages for testing.
 *
 * Features:
 * - Relay events from upstream simulator to daemon
 * - Intercept ACK messages from daemon
 * - Delay or drop ACKs to trigger timeout scenarios
 * - Simulate missed events by buffering messages
 */

import * as WebSocket from 'ws';
import * as http from 'http';

export interface ProxyOptions {
  proxyPort: number;
  upstreamHost: string;
  upstreamPort: number;
}

export interface ProxyStats {
  eventsRelayed: number;
  acksReceived: number;
  acksDelayed: number;
  acksDropped: number;
}

/**
 * WebSocket Proxy Simulator class
 * Can be instantiated and controlled programmatically in tests
 */
export class WebSocketProxySimulator {
  private server: http.Server | null = null;
  private wss: WebSocket.WebSocketServer | null = null;
  private connections: Map<WebSocket.WebSocket, {
    upstream: WebSocket.WebSocket;
    eventBuffer: any[];
    messageBuffer: any[];
    stats: ProxyStats;
  }> = new Map();

  private options: ProxyOptions;

  // Deterministic control over ACK behavior
  private delayNextAck: number | null = null; // Delay in ms for next ACK, or null for no delay
  private dropNextAck: boolean = false; // Whether to drop the next ACK
  private pendingAcks: Array<{ message: any; upstreamWs: WebSocket.WebSocket; clientWs: WebSocket.WebSocket }> = [];

  constructor(options: ProxyOptions) {
    this.options = options;
  }

  /**
   * Delay the next ACK by specified milliseconds
   */
  delayNextAckBy(ms: number): void {
    this.delayNextAck = ms;
  }

  /**
   * Drop the next ACK (don't forward it to upstream)
   */
  dropNextAckMessage(): void {
    this.dropNextAck = true;
  }

  /**
   * Get count of pending (delayed) ACKs
   */
  getPendingAckCount(): number {
    return this.pendingAcks.length;
  }

  /**
   * Flush all pending ACKs immediately
   */
  flushPendingAcks(): void {
    console.log(`Flushing ${this.pendingAcks.length} pending ACKs`);
    this.pendingAcks.forEach(({ message, upstreamWs }) => {
      upstreamWs.send(JSON.stringify(message));
      console.log(`Flushed ACK for event: ${message.eventId}`);
    });
    this.pendingAcks = [];
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { proxyPort, upstreamHost, upstreamPort } = this.options;
      const upstreamUrl = `ws://${upstreamHost}:${upstreamPort}/v1a/event_ws`;

      console.log('WebSocket Proxy Simulator starting...');
      console.log(`Proxy port: ${proxyPort}`);
      console.log(`Upstream: ${upstreamUrl}`);

      // Create HTTP server
      this.server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket Proxy Simulator\n');
      });

      // Create WebSocket server
      this.wss = new WebSocket.WebSocketServer({ server: this.server });

      this.setupConnectionHandler(upstreamUrl);

      // Start server
      this.server.listen(proxyPort, () => {
        console.log(`WebSocket Proxy listening on port ${proxyPort}`);
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      this.connections.forEach((data, clientWs) => {
        data.upstream.close();
        clientWs.close();
      });
      this.connections.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP server
          if (this.server) {
            this.server.close(() => {
              console.log('Proxy server stopped');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get statistics from all connections
   */
  getStats(): ProxyStats {
    const aggregated: ProxyStats = {
      eventsRelayed: 0,
      acksReceived: 0,
      acksDelayed: 0,
      acksDropped: 0,
    };

    this.connections.forEach((data) => {
      aggregated.eventsRelayed += data.stats.eventsRelayed;
      aggregated.acksReceived += data.stats.acksReceived;
      aggregated.acksDelayed += data.stats.acksDelayed;
      aggregated.acksDropped += data.stats.acksDropped;
    });

    return aggregated;
  }

  private setupConnectionHandler(upstreamUrl: string): void {
    if (!this.wss) {
      throw new Error('WebSocket server not initialized');
    }

    this.wss.on('connection', (clientWs: WebSocket.WebSocket) => {
      console.log('Client connected to proxy');

      // Connect to upstream simulator
      const upstreamWs = new WebSocket.WebSocket(upstreamUrl);

      const connectionData = {
        upstream: upstreamWs,
        eventBuffer: [] as any[],
        messageBuffer: [] as any[], // Buffer for messages until upstream is connected
        stats: {
          eventsRelayed: 0,
          acksReceived: 0,
          acksDelayed: 0,
          acksDropped: 0,
        },
      };

      this.connections.set(clientWs, connectionData);

      // Handle upstream connection opened
      upstreamWs.on('open', () => {
        console.log('Connected to upstream simulator');

        // Flush any buffered messages
        if (connectionData.messageBuffer.length > 0) {
          console.log(`Flushing ${connectionData.messageBuffer.length} buffered messages to upstream`);
          connectionData.messageBuffer.forEach(msg => {
            upstreamWs.send(msg);
          });
          connectionData.messageBuffer = [];
        }
      });

      // Handle upstream messages (events from simulator)
      upstreamWs.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());

          // Relay event to client immediately
          clientWs.send(JSON.stringify(message));
          connectionData.stats.eventsRelayed++;

          if (message.type === 'FULLNODE_EVENT') {
            console.log(`Relayed event: ${message.event?.type || 'unknown'} (id: ${message.event?.id})`);
          }
        } catch (error) {
          console.error('Error processing upstream message:', error);
          // Relay as-is if not JSON
          clientWs.send(data);
        }
      });

      // Handle client messages (ACKs from daemon)
      clientWs.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());

          // Check if this is an ACK message
          if (message.type === 'ACK') {
            connectionData.stats.acksReceived++;
            console.log(`Received ACK for event: ${message.eventId}`);

            // Check if we should drop this ACK
            if (this.dropNextAck) {
              connectionData.stats.acksDropped++;
              console.log(`Dropping ACK for event: ${message.eventId}`);
              this.dropNextAck = false; // Reset flag
              return; // Don't forward the ACK
            }

            // Check if we should delay this ACK
            if (this.delayNextAck !== null) {
              const delayMs = this.delayNextAck;
              connectionData.stats.acksDelayed++;
              console.log(`Delaying ACK for ${delayMs}ms`);

              // Store for later
              this.pendingAcks.push({ message, upstreamWs, clientWs });
              this.delayNextAck = null; // Reset

              // Set timeout to forward later
              setTimeout(() => {
                // Remove from pending
                const index = this.pendingAcks.findIndex(a => a.message.eventId === message.eventId);
                if (index >= 0) {
                  this.pendingAcks.splice(index, 1);
                }
                // Forward the delayed ACK (check if still open)
                if (upstreamWs.readyState === WebSocket.WebSocket.OPEN) {
                  upstreamWs.send(JSON.stringify(message));
                  console.log(`Forwarded delayed ACK for event: ${message.eventId}`);
                }
              }, delayMs);
            } else {
              // Forward ACK immediately (buffer if not open yet)
              const msgStr = JSON.stringify(message);
              if (upstreamWs.readyState === WebSocket.WebSocket.OPEN) {
                upstreamWs.send(msgStr);
              } else {
                connectionData.messageBuffer.push(msgStr);
              }
            }
          } else {
            // Forward other messages immediately (buffer if not open yet)
            const msgStr = JSON.stringify(message);
            if (upstreamWs.readyState === WebSocket.WebSocket.OPEN) {
              upstreamWs.send(msgStr);
            } else {
              connectionData.messageBuffer.push(msgStr);
            }
          }
        } catch (error) {
          console.error('Error processing client message:', error);
          // Relay as-is if not JSON (buffer if not open yet)
          if (upstreamWs.readyState === WebSocket.WebSocket.OPEN) {
            upstreamWs.send(data);
          } else {
            connectionData.messageBuffer.push(data);
          }
        }
      });

      // Handle upstream errors
      upstreamWs.on('error', (error) => {
        console.error('Upstream WebSocket error:', error);
        clientWs.close(1011, 'Upstream connection error');
      });

      // Handle upstream close
      upstreamWs.on('close', () => {
        console.log('Upstream connection closed');
        clientWs.close();
      });

      // Handle client errors
      clientWs.on('error', (error) => {
        console.error('Client WebSocket error:', error);
      });

      // Handle client close
      clientWs.on('close', () => {
        console.log('Client disconnected');
        console.log('Stats:', connectionData.stats);
        upstreamWs.close();
        this.connections.delete(clientWs);
      });
    });
  }
}
