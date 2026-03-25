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
import { AwsLambdaInstrumentation } from '@opentelemetry/instrumentation-aws-lambda';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MysqlInstrumentation } from '@opentelemetry/instrumentation-mysql';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
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
    'service.name': process.env.OTEL_SERVICE_NAME || 'wallet-service-lambda',
    'deployment.environment': process.env.STAGE || 'local',
  }),
  ...(spanProcessor && { spanProcessor }),
  instrumentations: [
    new AwsLambdaInstrumentation({
      disableAwsContextPropagation: true,
    }),
    new AwsInstrumentation(),
    new HttpInstrumentation(),
    new MysqlInstrumentation(),
    new RedisInstrumentation(),
    new WinstonInstrumentation(),
  ],
});

sdk.start();
