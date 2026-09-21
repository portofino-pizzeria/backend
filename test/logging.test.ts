// D4's log-minimisation half: the client IP is off every successful request,
// and present on the failing ones.
//
// These tests drive the REAL logger. `buildApp({ logger: true, logStream })`
// builds the same Fastify instance the server process builds, with the same
// serializer, and writes its ndjson into a buffer this file then parses. A test
// that inspected the serializer function directly would pass while Fastify
// quietly stopped using it.

import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

type LogLine = Record<string, any>;

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function capture(): { stream: Writable; lines: () => LogLine[]; raw: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    raw: () => buffer,
    lines: () =>
      buffer
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LogLine),
  };
}

async function loggingApp(): Promise<ReturnType<typeof capture>> {
  const log = capture();
  app = await buildApp({ logger: true, logStream: log.stream });
  return log;
}

/**
 * `inject` resolves when the response ends; the `onResponse` hook runs on the
 * socket's `finish` event. Those are ordered in practice but nothing promises
 * the hook's write has reached the capture stream by the time the promise
 * settles, so yield once before reading the buffer. A flake guard, not a
 * correctness one.
 */
async function injected(...calls: Promise<unknown>[]): Promise<void> {
  await Promise.all(calls);
  await new Promise((resolve) => setImmediate(resolve));
}

const UNKNOWN_ORDER = '/api/orders/00000000-0000-0000-0000-000000000000';

describe('the request log carries no client IP on the way in', () => {
  it('drops remoteAddress and remotePort from every "incoming request" line', async () => {
    const log = await loggingApp();

    const ok = await app!.inject({ method: 'GET', url: '/api/health' });
    const missing = await app!.inject({ method: 'GET', url: UNKNOWN_ORDER });
    await injected();

    expect(ok.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);

    const incoming = log.lines().filter((l) => l.msg === 'incoming request');
    // One for the 2xx, one for the 4xx — the line is emitted at RECEIPT, before
    // any status code exists, which is exactly why it cannot be redacted by
    // status and has to lose the field outright.
    expect(incoming).toHaveLength(2);

    for (const line of incoming) {
      expect(line.req).toBeDefined();
      expect(line.req).not.toHaveProperty('remoteAddress');
      expect(line.req).not.toHaveProperty('remotePort');
      // The fields that make a request log useful are all still there.
      expect(line.req.method).toBe('GET');
      expect(typeof line.req.url).toBe('string');
    }
  });

  it('puts no IP anywhere in a successful request', async () => {
    const log = await loggingApp();

    await injected(app!.inject({ method: 'GET', url: '/api/health' }));

    for (const line of log.lines()) {
      expect(line).not.toHaveProperty('ip');
      expect(line.req ?? {}).not.toHaveProperty('remoteAddress');
    }
    // light-my-request dials from 127.0.0.1; if anything logged the peer, this
    // catches it whatever key it used.
    expect(log.raw()).not.toContain('127.0.0.1');
  });
});

describe('the client IP comes back on failures only', () => {
  it('logs ip, statusCode and url on a 4xx, and on nothing else', async () => {
    const log = await loggingApp();

    await injected(app!.inject({ method: 'GET', url: '/api/health' })); // 2xx
    await injected(app!.inject({ method: 'GET', url: UNKNOWN_ORDER })); // 4xx

    const withIp = log.lines().filter((l) => 'ip' in l);

    expect(withIp).toHaveLength(1);
    expect(withIp[0].msg).toBe('request failed');
    expect(withIp[0].statusCode).toBe(404);
    expect(withIp[0].url).toBe(UNKNOWN_ORDER);
    expect(withIp[0].ip).toBe('127.0.0.1');
  });

  it('logs the IP on a 401 too — the case it exists for', async () => {
    const log = await loggingApp();

    // The owner editor fails closed and the suite arms it, so a bare call is a
    // real 401 through the real guard.
    const res = await app!.inject({ method: 'GET', url: '/api/admin/menu' });
    await injected();
    expect(res.statusCode).toBe(401);

    const withIp = log.lines().filter((l) => 'ip' in l);
    expect(withIp).toHaveLength(1);
    expect(withIp[0].statusCode).toBe(401);
  });
});

describe('the D3 access token never reaches the log', () => {
  it('is not in any logged url, because it travels in a header', async () => {
    const log = await loggingApp();
    const TOKEN = 'aVeryDistinctiveOrderAccessTokenValue0123456';

    await injected(
      app!.inject({
        method: 'GET',
        url: UNKNOWN_ORDER,
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    // The whole captured stream, not just the url field: a header that leaked
    // into any serializer would show up here too.
    expect(log.raw()).not.toContain(TOKEN);
    for (const line of log.lines()) {
      expect(JSON.stringify(line)).not.toContain(TOKEN);
    }
  });

  it('would have caught a token in the query string', async () => {
    // The guard is only meaningful if the log DOES record the url — otherwise
    // the test above passes for the wrong reason. This proves the url is
    // logged, which is precisely why D3 refuses to put the token in it.
    const log = await loggingApp();

    await injected(
      app!.inject({ method: 'GET', url: `${UNKNOWN_ORDER}?proof=in-the-url` }),
    );

    expect(log.raw()).toContain('proof=in-the-url');
  });
});
