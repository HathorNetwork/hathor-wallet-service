/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MySQLInstrumentation } from '@opentelemetry/instrumentation-mysql';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const spanProcessor = endpoint
  ? new BatchSpanProcessor(
      new OTLPTraceExporter(),
      {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 5000,
      },
    )
  : undefined;

const sdk = new NodeSDK({
  resource: new Resource({
    'service.name': process.env.OTEL_SERVICE_NAME || 'wallet-service-daemon',
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    'service.version': process.env.SERVICE_VERSION || require('../../package.json').version,
    'deployment.environment': process.env.STAGE || 'local',
  }),
  ...(spanProcessor && { spanProcessor }),
  instrumentations: [
    new HttpInstrumentation(),
    new MySQLInstrumentation(),
    new WinstonInstrumentation(),
  ],
});

sdk.start();

process.once('SIGTERM', async () => {
  try {
    await sdk.shutdown();
    process.exit(0);
  } catch (err) {
    console.error('OTel SDK shutdown error:', err);
    process.exit(1);
  }
});
