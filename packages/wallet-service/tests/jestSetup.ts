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

const normalizeHost = (host: string | undefined): string => {
  if (!host) return '<unknown>';
  // `host` may include a port (e.g. `localhost:3000`) and IPv6 forms may be
  // bracketed (e.g. `[::1]:3000`). Let URL parsing strip both consistently —
  // ALLOWED_HOSTS is keyed by hostname only.
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
};

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
  return arg.hostname || normalizeHost(arg.host);
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

// Node's `http.get` / `https.get` keep an internal reference to the original
// `http.request`, so patching only `request` would leave `get` as a bypass.
// Delegate `get` through the patched `request` and call `.end()` ourselves to
// preserve the stock `get()` behavior for any allow-listed host.
const blockGet = (blockedRequest: typeof http.request) => (
  (...args: unknown[]) => {
    // @ts-ignore - passthrough to wrapped request overloads
    const req = blockedRequest(...args);
    req.end();
    return req;
  }
);

const blockedHttpRequest = blockRequest('http', http.request) as typeof http.request;
const blockedHttpsRequest = blockRequest('https', https.request) as typeof https.request;

http.request = blockedHttpRequest;
https.request = blockedHttpsRequest;
http.get = blockGet(blockedHttpRequest) as typeof http.get;
https.get = blockGet(blockedHttpsRequest) as typeof https.get;
