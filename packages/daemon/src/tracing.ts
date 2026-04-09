/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Skip all OTel initialization when disabled — avoids module loading cost.
if (process.env.OTEL_SDK_DISABLED !== 'true') {
  // Use require() so that imports are fully skipped when disabled.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
  const { Resource } = require('@opentelemetry/resources');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { MySQLInstrumentation } = require('@opentelemetry/instrumentation-mysql');
  const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston');

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

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      process.exit(0);
    } catch (err) {
      console.error('OTel SDK shutdown error:', err);
      process.exit(1);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
