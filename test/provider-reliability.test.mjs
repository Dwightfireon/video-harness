import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, createProviderPool,
  requestChat, ProviderPoolError, ProviderRequestError } from '../lib/provider-pool.mjs';
import { canRetryRequest } from '../lib/network-diagnostics.mjs';

const provider = { name: 'opencode-go', model: 'MiniMax-M2.5', modelExplicit: true,
  base: 'https://fixture.invalid/go', key: 'fixture-private-key', headers: { 'x-private': 'fixture-private-header' } };
const candidates = [provider, { ...provider, name: 'opendesign', base: 'https://fixture.invalid/od' },
  { ...provider, name: 'commandcode', base: 'https://fixture.invalid/cc' }];
const reply = { choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }] };
const response = (body = reply, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const transportError = code => new TypeError('fixture-private-key fixture-private-header PRIVATE-ARTICLE', {
  cause: Object.assign(new Error('never log upstream text'), { code }),
});
const tools = [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }];
const messages = [{ role: 'user', content: 'PRIVATE-ARTICLE' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'already-done', type: 'function',
    function: { name: 'write_file', arguments: '{"path":"proof.txt"}' } }] },
  { role: 'tool', tool_call_id: 'already-done', content: 'write completed once' }];

// Every request uses this injected fetch. No server, network, credentials, agent or state files.
function mockPool(fetchImpl, options = {}) {
  const calls = [], logs = [];
  const pool = createProviderPool({ candidates, preferred: provider.name, retryDelayMs: 0,
    ...options, log: line => logs.push(line), request: (p, m, t, opts) => {
      calls.push({ provider: p, messages: m, tools: t, options: opts });
      return requestChat(p, m, t, { ...opts, fetchImpl });
    } });
  return { pool, calls, logs };
}

test('opencode-go ECONNRESET before headers retries once with identical context/tools/model/budget', async () => {
  const bodies = [], urls = [], before = structuredClone(messages), successes = [];
  const { pool, calls, logs } = mockPool(async (url, init) => {
    urls.push(url); bodies.push(init.body);
    if (bodies.length === 1) throw transportError('ECONNRESET');
    return response();
  }, { onSuccess: p => successes.push(p.name) });
  assert.deepEqual(await pool.chat(messages, tools), reply);
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].provider, calls[1].provider);
  assert.strictEqual(calls[0].messages, calls[1].messages);
  assert.strictEqual(calls[0].tools, tools);
  assert.strictEqual(calls[1].tools, tools);
  assert.equal(bodies[0], bodies[1]);
  const body = JSON.parse(bodies[1]);
  assert.equal(body.model, provider.model);
  assert.equal(body.max_tokens, 6000);
  assert.equal(body.messages.filter(m => m.tool_call_id === 'already-done').length, 1);
  assert.deepEqual(messages, before);
  assert.deepEqual(urls, [provider.base + '/chat/completions', provider.base + '/chat/completions']);
  assert.deepEqual(successes, [provider.name]);
  assert.match(logs.join('\n'), /⚠ opencode-go：.*transport \/ awaiting-headers \/ ECONNRESET.*0B received.*同一渠道重试 1\/1/);
  assert.doesNotMatch(logs.join('\n'), /⚠ opendesign|fixture-private|PRIVATE-ARTICLE/);
});

test('repeated opencode-go ECONNRESET fails after two attempts without fallback or leaked text', async () => {
  const { pool, calls, logs } = mockPool(async () => { throw transportError('ECONNRESET'); });
  await assert.rejects(pool.chat(messages, tools), error => {
    assert.ok(error instanceof ProviderPoolError);
    const [failure] = error.failures;
    assert.equal(failure.provider, provider.name);
    assert.equal(failure.attempts, 2);
    assert.equal(failure.diagnostics.source, 'transport');
    assert.equal(failure.diagnostics.phase, 'awaiting-headers');
    assert.equal(failure.diagnostics.receivedBytes, 0);
    assert.deepEqual(failure.diagnostics.networkCodes, ['ECONNRESET']);
    assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-private|PRIVATE-ARTICLE|never log/);
    return true;
  });
  assert.deepEqual(calls.map(c => c.provider.name), [provider.name, provider.name]);
  assert.doesNotMatch(logs.join('\n'), /fixture-private|PRIVATE-ARTICLE/);
});

test('known transient transport codes retry once for every explicitly selected provider', async t => {
  for (const name of ['opencode-go', 'commandcode', 'opendesign']) {
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']) {
      await t.test(name + ' ' + code, async () => {
        let count = 0;
        const { pool, calls } = mockPool(async () => {
          if (++count === 1) throw transportError(code);
          return response();
        }, { preferred: name });
        await pool.chat([], []);
        assert.deepEqual(calls.map(c => c.provider.name), [name, name]);
      });
    }
  }
});

test('known HTTP and API server failures/timeouts retry at most once, preserving selected provider', async t => {
  for (const status of [408, 500, 502, 503, 504]) {
    await t.test('HTTP ' + status, async () => {
      const { pool, calls } = mockPool(async () => response({ error: { message: 'fixture-private-key' } }, status));
      await assert.rejects(pool.chat([], []), error => {
        assert.equal(error.failures[0].status, status);
        assert.equal(error.failures[0].attempts, 2);
        return true;
      });
      assert.deepEqual(calls.map(c => c.provider.name), [provider.name, provider.name]);
    });
  }
  const { pool, calls } = mockPool(async () => response({ error: { status: 503 } }));
  await assert.rejects(pool.chat([], []), error => {
    assert.equal(error.failures[0].status, 200);
    assert.equal(error.failures[0].diagnostics.apiStatus, 503);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('local header timeout retries once on opencode-go without treating cancellation as timeout', async () => {
  let count = 0;
  const { pool, calls } = mockPool(async (_url, { signal }) => {
    if (++count === 2) return response();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 1000, headerTimeoutMs: 10, idleTimeoutMs: 1000 });
  await pool.chat([], []);
  assert.equal(calls.length, 2);
});

test('auth, quota, rate, content, request, protocol and unknown failures do not retry', async t => {
  const failures = [
    ['auth', () => response({ error: {} }, 401)],
    ['permission', () => response({ error: {} }, 403)],
    ['quota', () => response({ error: {} }, 402)],
    ['rate', () => response({ error: {} }, 429)],
    ['request', () => response({ error: {} }, 400)],
    ['unknown server status', () => response({ error: {} }, 501)],
    ['unknown server status 505', () => response({ error: {} }, 505)],
    ['API quota', () => response({ error: { code: 'insufficient_quota' } })],
    ['API unknown', () => response({ error: { code: 'some_unknown_error' } })],
    ['500 quota', () => response({ error: { code: 'quota_exhausted' } }, 500)],
    ['500 auth', () => response({ error: { code: 'invalid_api_key' } }, 500)],
    ['500 content', () => response({ error: { code: 'content_policy' } }, 500)],
    ['500 request', () => response({ error: { type: 'invalid_request_error' } }, 500)],
    ['500 output budget', () => response({ error: { message: 'max_tokens exceeds limit' } }, 500)],
    ['invalid JSON', () => new Response('fixture-private-key')],
    ['invalid protocol', () => response({ choices: [] })],
    ['truncated output', () => response({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{' } }] }, finish_reason: 'length' }] })],
    ['unknown transport', () => { throw transportError('UNKNOWN_PRIVATE_CODE'); }],
    ['DNS', () => { throw transportError('ENOTFOUND'); }],
    ['refused', () => { throw transportError('ECONNREFUSED'); }],
  ];
  for (const [name, fail] of failures) {
    await t.test(name, async () => {
      const { pool, calls, logs } = mockPool(async () => fail());
      await assert.rejects(pool.chat(messages, tools), error => {
        assert.equal(error.failures[0].attempts, 1);
        assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-private|PRIVATE-ARTICLE|UNKNOWN_PRIVATE_CODE/);
        return true;
      });
      assert.equal(calls.length, 1);
      assert.doesNotMatch(logs.join('\n'), /fixture-private|PRIVATE-ARTICLE|UNKNOWN_PRIVATE_CODE/);
    });
  }
});

test('certificate failures never retry, even when nested with a transient code', async t => {
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED']) {
    await t.test(code, async () => {
      const { pool, calls } = mockPool(async () => { throw new AggregateError([transportError('ECONNRESET'), transportError(code)]); });
      await assert.rejects(pool.chat([], []));
      assert.equal(calls.length, 1);
      assert.equal(canRetryRequest(provider.name, new ProviderRequestError('timeout', {
        diagnostics: { networkCodes: ['ECONNRESET', code] },
      })), false);
    });
  }
});

test('retry wait is cancellable immediately and cannot send a second request', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let startedWaiting;
  const waiting = new Promise(resolve => { startedWaiting = resolve; });
  let count = 0;
  const pool = createProviderPool({ candidates, preferred: provider.name, retryDelayMs: 30000,
    request: async () => { count++; throw new ProviderRequestError('network', { diagnostics: { networkCodes: ['ECONNRESET'] } }); },
    log: line => { if (line.includes('同一渠道重试')) startedWaiting(); } });
  const pending = pool.chat(messages, tools, controller.signal);
  await waiting;
  controller.abort();
  await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(count, 1);
});

test('already aborted requests make no calls; excessive Retry-After does not wait or retry', async () => {
  const controller = new AbortController(); controller.abort();
  const { pool, calls } = mockPool(async () => response({ error: {} }, 503, { 'retry-after': '31' }));
  await assert.rejects(pool.chat([], [], controller.signal), error => error === controller.signal.reason);
  assert.equal(calls.length, 0);
  await assert.rejects(pool.chat([], []));
  assert.equal(calls.length, 1);
});

function longHistory() {
  return [{ role: 'user', content: 'keep original request' }, ...Array.from({ length: 6 }, (_, i) => [
    { role: 'assistant', content: null, tool_calls: [{ id: 'done-' + i, type: 'function',
      function: { name: 'write_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'done-' + i, content: 'x'.repeat(3000) },
  ]).flat()];
}

test('context correction and tool_choice fallback share the same two-attempt total with transient retry', async t => {
  const fail = kind => kind === 'transient' ? new ProviderRequestError('network', { diagnostics: { networkCodes: ['ECONNRESET'] } }) :
    new ProviderRequestError('request', { diagnostics: { apiCode: kind } });
  for (const first of ['transient', 'context_length_exceeded', 'unsupported_tool_choice']) {
    for (const second of ['transient', 'context_length_exceeded', 'unsupported_tool_choice']) {
      await t.test(first + ' then ' + second, async () => {
        const history = longHistory(), before = structuredClone(history), calls = [];
        const pool = createProviderPool({ candidates, preferred: provider.name, retryDelayMs: 0,
          request: async (p, m, t, opts) => {
            calls.push({ p, m, t, toolChoice: opts.toolChoice });
            throw fail(calls.length === 1 ? first : second);
          } });
        await assert.rejects(pool.chat(history, tools, undefined, 'keep task note', { toolChoice: 'write_file' }), error => {
          assert.equal(error.failures[0].attempts, 2);
          return true;
        });
        assert.equal(calls.length, 2);
        assert.strictEqual(calls[0].p, calls[1].p);
        assert.strictEqual(calls[0].t, calls[1].t);
        if (first === 'unsupported_tool_choice') assert.equal(calls[1].toolChoice, undefined);
        if (first === 'context_length_exceeded') assert.ok(JSON.stringify(calls[1].m).length < JSON.stringify(calls[0].m).length);
        else assert.strictEqual(calls[0].m, calls[1].m);
        for (const { m } of calls) {
          assert.match(JSON.stringify(m), /keep original request/);
          assert.equal(m.filter(message => message.content === 'keep task note').length, 1);
          const ids = m.filter(message => message.role === 'tool').map(message => message.tool_call_id);
          assert.equal(new Set(ids).size, ids.length);
          for (const id of ids) assert.ok(m.some(message => message.tool_calls?.some(call => call.id === id)));
        }
        assert.deepEqual(history, before);
      });
    }
  }
});

test('supported corrections can succeed on the second request while retaining the explicit output budget', async t => {
  for (const code of ['context_length_exceeded', 'unsupported_tool_choice']) {
    await t.test(code, async () => {
      const bodies = [];
      const { pool, calls } = mockPool(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return bodies.length === 1 ? response({ error: { code,
          message: code === 'unsupported_tool_choice' ? 'tool_choice is not supported' : code } }, 400) : response();
      });
      assert.deepEqual(await pool.chat(longHistory(), tools, undefined, 'keep task note', {
        toolChoice: 'write_file', maxOutputTokens: 16384,
      }), reply);
      assert.equal(calls.length, 2);
      assert.deepEqual(bodies.map(body => body.max_tokens), [16384, 16384]);
      assert.deepEqual(bodies[0].tool_choice, { type: 'function', function: { name: 'write_file' } });
      if (code === 'unsupported_tool_choice') {
        assert.equal(bodies[1].tool_choice, 'auto');
        assert.equal(bodies[1].parallel_tool_calls, undefined);
        assert.deepEqual(bodies[0].messages, bodies[1].messages);
      } else {
        assert.ok(JSON.stringify(bodies[1].messages).length < JSON.stringify(bodies[0].messages).length);
        assert.deepEqual(bodies[0].tool_choice, bodies[1].tool_choice);
      }
    });
  }
});

test('maxOutputTokens is a strict bounded integer with a backward compatible default', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 6000);
  assert.equal(configureMaxOutputTokens(), 6000);
  for (const value of [256, 6000, 16384, 65536]) assert.equal(configureMaxOutputTokens(value), value);
  for (const value of [null, true, false, '', '8192', 'fixture-private-key', 0, -1, 255, 65537, 1.5, NaN, Infinity, {}, []]) {
    assert.throws(() => configureMaxOutputTokens(value), error => {
      assert.ok(error instanceof RangeError);
      assert.doesNotMatch(error.message, /fixture-private/);
      return true;
    });
  }
});

test('request and provider/capability output budgets configure only max_tokens, not reasoning fields', async () => {
  for (const [prov, options, expected] of [
    [provider, {}, 6000],
    [{ ...provider, capabilities: { maxOutputTokens: 8192 } }, {}, 8192],
    [{ ...provider, maxOutputTokens: 12288, capabilities: { maxOutputTokens: 8192 } }, {}, 12288],
    [{ ...provider, maxOutputTokens: 12288 }, { maxOutputTokens: 16384 }, 16384],
  ]) {
    const bodies = [];
    await requestChat(prov, [], [], { ...options, fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(); } });
    assert.equal(bodies[0].max_tokens, expected);
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    assert.equal(bodies[0].model, provider.model);
  }
});

test('pool budget overrides are per chat, remain constant on retry, and do not mutate provider config', async () => {
  const configured = { ...provider, capabilities: { maxOutputTokens: 8192 } };
  const budgets = [];
  const { pool } = mockPool(async (_url, init) => {
    budgets.push(JSON.parse(init.body).max_tokens);
    if (budgets.length === 1) throw transportError('ECONNRESET');
    return response();
  }, { candidates: [configured] });
  assert.equal(pool.current().maxOutputTokens, 8192);
  await pool.chat([], [], undefined, '', { maxOutputTokens: 16384 });
  await pool.chat([], []);
  assert.deepEqual(budgets, [16384, 16384, 8192]);
  assert.equal(configured.maxOutputTokens, undefined);
  assert.equal(pool.current().maxOutputTokens, 8192);
});

test('invalid output budgets fail before any fetch and never echo the supplied value', async () => {
  let calls = 0;
  for (const value of [null, 255, 65537, 1000.5, 'fixture-private-key']) {
    const fetchImpl = async () => { calls++; return response(); };
    await assert.rejects(requestChat(provider, [], [], { maxOutputTokens: value, fetchImpl }), RangeError);
    await assert.rejects(requestChat({ ...provider, capabilities: { maxOutputTokens: value } }, [], [], { fetchImpl }), RangeError);
    assert.throws(() => createProviderPool({ candidates: [{ ...provider, maxOutputTokens: value }], preferred: provider.name }), RangeError);
    const { pool } = mockPool(fetchImpl);
    await assert.rejects(pool.chat([], [], undefined, '', { maxOutputTokens: value }), RangeError);
  }
  assert.equal(calls, 0);
});
