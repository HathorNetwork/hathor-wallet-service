# OpenTelemetry Cold Start Benchmark Report

**Date:** 2026-03-26
**Environment:** dev-testnet (eu-central-1)
**Function:** `hathor-wallet-service-dev-testnet-getLatestBlock`
**Runtime:** Node.js 22.x, 256 MB memory
**Method:** A/B test — forced cold starts by updating function config between invocations, toggling `OTEL_SDK_DISABLED` env var

## Instrumentation Config

Cherry-picked instrumentations (not the full `auto-instrumentations-node` meta-package):
- `@opentelemetry/instrumentation-aws-lambda`
- `@opentelemetry/instrumentation-aws-sdk`
- `@opentelemetry/instrumentation-http`
- `@opentelemetry/instrumentation-mysql`
- `@opentelemetry/instrumentation-redis`
- `@opentelemetry/instrumentation-winston`

## Test 1: Cold Start Overhead (console debug ON)

Console exporter enabled (`OTEL_CONSOLE_DEBUG=true`), no OTLP endpoint configured.

### WITH OTel (n=7)

| # | Init Duration (ms) | Handler Duration (ms) |
|---|-------------------:|----------------------:|
| 1 | 1979 | 1231 |
| 2 | 1846 | 1297 |
| 3 | 1829 | 1246 |
| 4 | 1868 | 1256 |
| 5 | 1874 | 1241 |
| 6 | 1822 | 1261 |
| 7 | 1872 | 1321 |

### WITHOUT OTel (n=7)

| # | Init Duration (ms) | Handler Duration (ms) |
|---|-------------------:|----------------------:|
| 1 | 1143 | 591 |
| 2 | 1170 | 615 |
| 3 | 1133 | 927 |
| 4 | 1142 | 949 |
| 5 | 1151 | 918 |
| 6 | 1163 | 610 |
| 7 | 1242 | 634 |

### Cold Start Results

| Metric | WITHOUT OTel | WITH OTel | Delta |
|--------|------------:|----------:|------:|
| **Avg Init** | 1164 ms | 1870 ms | **+706 ms (+60.7%)** |
| Min Init | 1133 ms | 1822 ms | +689 ms |
| Max Init | 1242 ms | 1979 ms | +737 ms |

## Test 2: Warm Handler Duration (console debug OFF, production-like)

OTel enabled, `OTEL_CONSOLE_DEBUG` off, no OTLP endpoint — simulates production config where spans are created but not exported. 10 warm invocations per phase.

### OTel ON (n=10)

| # | Duration (ms) |
|---|-------------:|
| 1 | 24.2 |
| 2 | 10.5 |
| 3 | 9.5 |
| 4 | 11.5 |
| 5 | 199.9 |
| 6 | 9.7 |
| 7 | 16.7 |
| 8 | 18.3 |
| 9 | 15.2 |
| 10 | 64.0 |

### OTel OFF (n=10)

| # | Duration (ms) |
|---|-------------:|
| 1 | 10.9 |
| 2 | 10.4 |
| 3 | 9.5 |
| 4 | 9.3 |
| 5 | 9.7 |
| 6 | 8.9 |
| 7 | 9.2 |
| 8 | 16.1 |
| 9 | 9.7 |
| 10 | 8.7 |

### Warm Handler Results

| Metric | OTel OFF | OTel ON | Delta |
|--------|--------:|-------:|------:|
| **Median** | 9.6 ms | 15.9 ms | **+6.3 ms** |
| Avg | 10.2 ms | 38.0 ms | +27.7 ms (skewed by spikes) |
| p95 | 16.1 ms | 199.9 ms | +184 ms |
| Min | 8.7 ms | 9.5 ms | +0.8 ms |
| Max | 16.1 ms | 199.9 ms | +184 ms |

The median overhead is ~6ms, but there are periodic spikes (64ms, 200ms) likely caused by the `BatchSpanProcessor` doing internal bookkeeping even without an exporter. In production with an OTLP exporter, the batch flush would also involve network I/O, though it runs asynchronously.

## Key Takeaways

1. **Cold start overhead is ~700ms**, within the RFC's estimated 200-800ms range. Results are highly consistent (tight min/max spread).

2. **Warm invocation median overhead is ~6ms** — negligible for most use cases. However, periodic spikes of 60-200ms occur from internal `BatchSpanProcessor` activity.

3. **The console exporter is expensive.** `OTEL_CONSOLE_DEBUG=true` adds ~500ms to every invocation due to synchronous span serialization. Use only for short debugging sessions, never in production.

4. The warmup plugin keeps 13 functions hot with 5-minute pings, so most real user requests will not experience cold starts.

## Recommendations

- **Accept the cold start cost** — 700ms is manageable given warmup coverage. Most users will never hit a cold start.
- **Disable `OTEL_CONSOLE_DEBUG`** except when debugging — it adds ~500ms to every invocation.
- **Use `OTEL_SDK_DISABLED=true`** as a kill switch if issues arise in production.
- **Monitor p95 latency after enabling** — the periodic BatchSpanProcessor spikes could affect tail latency on latency-sensitive endpoints.
- **Consider provisioned concurrency** for latency-critical endpoints if the +700ms cold start is unacceptable.
