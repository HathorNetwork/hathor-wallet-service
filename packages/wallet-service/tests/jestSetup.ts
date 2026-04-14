/* eslint-disable @typescript-eslint/no-empty-function */
import http from 'http';
import https from 'https';
import { config } from 'dotenv';
import { stopGLLBackgroundTask } from '@hathor/wallet-lib';

Object.defineProperty(global, '_bitcore', { get() { return undefined; }, set() {} });

stopGLLBackgroundTask();
config();

/**
 * Block all real outbound HTTP/HTTPS requests from unit tests.
 *
 * Tests must mock their network dependencies. If a test accidentally reaches
 * this point, it means a code path escaped mocking (e.g. a handler calls
 * `fullnode.version()` without the `version_data` DB cache being seeded, or
 * a direct `axios.get(...)` without a `jest.spyOn` / `jest.mock`). We throw
 * a loud, explanatory error instead of silently hitting the public internet.
 *
 * Hosts listed in `ALLOWED_HOSTS` are permitted — the list is intentionally
 * empty for the wallet-service unit suite. Integration tests use a separate
 * jest config and should opt in explicitly if they need real connections.
 */
const ALLOWED_HOSTS = new Set<string>([]);

type RequestArg = string | URL | http.RequestOptions;

const extractHostname = (arg: RequestArg | undefined): string => {
  if (!arg) return '<unknown>';
  if (typeof arg === 'string') {
    try {
      return new URL(arg).hostname;
    } catch {
      return arg;
    }
  }
  if (arg instanceof URL) return arg.hostname;
  return arg.hostname || arg.host || '<unknown>';
};

const describeRequest = (protocol: 'http' | 'https', arg: RequestArg | undefined): string => {
  if (!arg) return `${protocol}://<unknown>`;
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  const host = arg.host || arg.hostname || '<unknown>';
  const path = arg.path || '/';
  return `${protocol}://${host}${path}`;
};

const blockRequest = (protocol: 'http' | 'https', originalRequest: typeof http.request) => (
  (...args: unknown[]) => {
    const firstArg = args[0] as RequestArg | undefined;
    const hostname = extractHostname(firstArg);
    if (ALLOWED_HOSTS.has(hostname)) {
      // @ts-ignore - passthrough
      return originalRequest(...args);
    }
    throw new Error(
      `[jestSetup] Blocked outbound ${protocol.toUpperCase()} request to ${describeRequest(protocol, firstArg)}. `
      + 'Tests must not make real network calls. Mock the HTTP client '
      + '(jest.spyOn / jest.mock) or seed the relevant DB cache (see '
      + 'tests/utils.ts#seedFullnodeVersionData).',
    );
  }
);

http.request = blockRequest('http', http.request) as typeof http.request;
https.request = blockRequest('https', https.request) as typeof https.request;
