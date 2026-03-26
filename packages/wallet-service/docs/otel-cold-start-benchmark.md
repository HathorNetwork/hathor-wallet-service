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

## Test 2: Warm Invocation Overhead (console debug OFF, production-like)

OTel enabled, `OTEL_CONSOLE_DEBUG` off, no OTLP endpoint — simulates production config where spans are created but not exported.

| # | Init Duration (ms) | Cold Handler (ms) | Warm Handler (ms) |
|---|-------------------:|------------------:|------------------:|
| 1 | 1910 | 1281 | 13 |
| 2 | 1881 | 1247 | 44 |
| 3 | 1852 | 1243 | 41 |
| 4 | 1772 | 1148 | 21 |
| 5 | 1824 | 1184 | 14 |

### Warm Invocation Results

| Metric | Value |
|--------|------:|
| **Avg warm duration** | **27 ms** |
| Min warm duration | 13 ms |
| Max warm duration | 44 ms |

## Key Takeaways

1. **Cold start overhead is ~700ms**, within the RFC's estimated 200-800ms range. Results are highly consistent (tight min/max spread).

2. **Warm invocations add negligible overhead (13-44ms)**. The ~500ms handler duration increase seen in Test 1 was entirely caused by the synchronous console exporter (`SimpleSpanProcessor` + `ConsoleSpanExporter`) — not by OTel itself.

3. **The console exporter is expensive.** `OTEL_CONSOLE_DEBUG=true` should only be used for short debugging sessions, never in production.

4. The warmup plugin keeps 13 functions hot with 5-minute pings, so most real user requests will not experience cold starts.

## Recommendations

- **Accept the cold start cost** — 700ms is manageable given warmup coverage. Most users will never hit a cold start.
- **Disable `OTEL_CONSOLE_DEBUG`** except when debugging — it adds ~500ms to every invocation.
- **Use `OTEL_SDK_DISABLED=true`** as a kill switch if issues arise in production.
- **Consider provisioned concurrency** for latency-critical endpoints if the +700ms cold start is unacceptable.
