/** Unit tests for the TRUST_PROXY coercion (no database). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trustProxyFrom } from '../src/app.js';

describe('trustProxyFrom', () => {
  // The regression this file exists for: "1" used to become boolean `true`, which tells proxy-addr
  // to trust every hop and therefore to believe the LEFT-MOST X-Forwarded-For entry — the one the
  // client sent. req.ip is written to audit_log.ip (the Municipal Elections Act artefact) and is the
  // login rate-limit key, so a forgeable value defeats both. A number means "trust this many hops",
  // and proxy-addr then reads from the right: the address Caddy itself set.
  it('reads a numeric string as a hop count, never as a boolean', () => {
    assert.equal(trustProxyFrom('1'), 1);
    assert.equal(trustProxyFrom('2'), 2);
    assert.equal(trustProxyFrom('0'), 0);
    assert.notEqual(trustProxyFrom('1'), true);
  });

  it('still honours the explicit boolean spellings', () => {
    assert.equal(trustProxyFrom('true'), true);
    assert.equal(trustProxyFrom('false'), false);
  });

  it('treats an unset value as untrusting rather than trust-all', () => {
    assert.equal(trustProxyFrom(''), false);
  });

  it('passes a CIDR or list through for proxy-addr to parse', () => {
    assert.equal(trustProxyFrom('127.0.0.1/8'), '127.0.0.1/8');
    assert.equal(trustProxyFrom('10.0.0.0/8,172.16.0.0/12'), '10.0.0.0/8,172.16.0.0/12');
  });
});
