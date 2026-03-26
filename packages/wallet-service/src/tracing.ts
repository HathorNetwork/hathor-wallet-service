/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Skip all OTel initialization when disabled — avoids module loading cost.
// eslint-disable-next-line no-console
console.log(`[tracing] OTEL_SDK_DISABLED=${process.env.OTEL_SDK_DISABLED || 'false'}`);
if (process.env.OTEL_SDK_DISABLED !== 'true') {
  // Use require() so that imports are fully skipped when disabled.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');
  const { Resource } = require('@opentelemetry/resources');
  const { AwsLambdaInstrumentation } = require('@opentelemetry/instrumentation-aws-lambda');
  const { AwsInstrumentation } = require('@opentelemetry/instrumentation-aws-sdk');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { MySQLInstrumentation } = require('@opentelemetry/instrumentation-mysql');
  const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis');
  const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston');

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const consoleDebug = process.env.OTEL_CONSOLE_DEBUG === 'true';

  const spanProcessors: any[] = [];

  if (endpoint) {
    spanProcessors.push(new BatchSpanProcessor(
      new OTLPTraceExporter(),
      {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 5000,
      },
    ));
  }

  if (consoleDebug) {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  const sdk = new NodeSDK({
    resource: new Resource({
      'service.name': process.env.OTEL_SERVICE_NAME || 'wallet-service-lambda',
      'deployment.environment': process.env.STAGE || 'local',
    }),
    ...(spanProcessors.length && { spanProcessors }),
    instrumentations: [
      new AwsLambdaInstrumentation({
        disableAwsContextPropagation: true,
      }),
      new AwsInstrumentation(),
      new HttpInstrumentation(),
      new MySQLInstrumentation(),
      new RedisInstrumentation(),
      new WinstonInstrumentation(),
    ],
  });

  sdk.start();
}
