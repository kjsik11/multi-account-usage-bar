import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-test-'));
process.env.USAGE_BAR_CONFIG_DIR = CFG;
process.env.USAGE_BAR_STORE = 'file';
// The 1.x store lives in a scratch directory too, so the migration is exercised on a
// fixture rather than on whatever the developer's machine still has.
process.env.USAGE_BAR_LEGACY_CONFIG_DIR = path.join(CFG, 'legacy-store');
process.env.CLAUDE_CONFIG_DIR = path.join(CFG, 'fake-claude');
// Point the Claude Code lookup at a service that cannot exist, so the suite never reads
// the developer's real login out of the Keychain nor spends it on a live request.
process.env.USAGE_BAR_CLAUDE_SERVICE = 'usage-bar-test-absent';
// Likewise for Codex: an empty CODEX_HOME means no live auth.json to read or overwrite.
process.env.CODEX_HOME = path.join(CFG, 'fake-codex');

const core = await import('../src/core.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : (input?.url ?? input));
  if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  throw new Error(`the test suite must not reach the network: ${url}`);
};

before(() => core.setLogger({ onWarn: () => {}, onInfo: () => {} }));
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

describe('account index', () => {
  it('treats a missing file as empty', () => {
    fs.rmSync(core.INDEX_FILE, { force: true });
    assert.deepEqual(core.loadIndex().accounts, []);
  });

  it('throws instead of silently reading a corrupt index as empty', () => {
    fs.mkdirSync(path.dirname(core.INDEX_FILE), { recursive: true });
    fs.writeFileSync(core.INDEX_FILE, '{"accounts":[{"email":"a@x.co"');
    assert.throws(() => core.loadIndex(), /unreadable/);
    fs.rmSync(core.INDEX_FILE);
  });
});

describe('store migration from 1.x', () => {
  const legacy = process.env.USAGE_BAR_LEGACY_CONFIG_DIR;

  it('moves the index, tokens and cache over on first use, then retires the old copies', () => {
    fs.rmSync(core.INDEX_FILE, { force: true });
    fs.rmSync(core.FILE_STORE, { force: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ email: 'old@x.com', label: 'old' }] }));
    fs.writeFileSync(path.join(legacy, 'tokens.json'), JSON.stringify({ 'old@x.com': { email: 'old@x.com', accessToken: 'legacy-token' } }));
    fs.writeFileSync(path.join(legacy, 'usage-cache.json'), JSON.stringify({ 'old@x.com': { fetchedAt: 1 } }));
    assert.deepEqual(core.loadIndex().accounts.map((a) => a.email), ['old@x.com']);
    assert.equal(core.tokenGet('old@x.com').accessToken, 'legacy-token');
    assert.deepEqual(JSON.parse(fs.readFileSync(core.CACHE_FILE, 'utf8')), { 'old@x.com': { fetchedAt: 1 } });
    assert.equal(fs.statSync(core.INDEX_FILE).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(legacy), false);
    core.tokenDelete('old@x.com');
    fs.rmSync(core.INDEX_FILE, { force: true });
  });

  it('never overwrites a store that already exists under the new name', () => {
    core.saveIndex({ version: 1, accounts: [{ email: 'new@x.com', label: 'new' }] });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ email: 'old@x.com', label: 'old' }] }));
    assert.deepEqual(core.loadIndex().accounts.map((a) => a.email), ['new@x.com']);
    assert.equal(fs.existsSync(path.join(legacy, 'accounts.json')), true);
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.rmSync(core.INDEX_FILE, { force: true });
  });
});

describe('findAccount', () => {
  before(() => {
    core.saveIndex({
      version: 1,
      accounts: [
        { email: 'me@work.com', label: 'me' },
        { email: 'me@home.com', label: 'me' },
        { email: 'solo@x.com', label: 'solo' },
      ],
    });
  });

  it('resolves an exact email even when labels collide', () => {
    assert.equal(core.findAccount('me@work.com').entry.email, 'me@work.com');
  });

  it('resolves a unique label', () => {
    assert.equal(core.findAccount('solo').entry.email, 'solo@x.com');
  });

  it('refuses an ambiguous label rather than picking one', () => {
    assert.throws(() => core.findAccount('me'), /matches 2 accounts/);
  });

  it('returns null for an unknown target', () => {
    assert.equal(core.findAccount('nobody'), null);
  });
});

describe('switchAccount', () => {
  it('refuses a read-only account instead of breaking Claude Code', async () => {
    core.saveIndex({ version: 1, accounts: [{ email: 'ro@x.com', label: 'ro' }] });
    core.tokenSet('ro@x.com', {
      email: 'ro@x.com',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3600e3,
      scopes: ['user:profile'],
    });
    await assert.rejects(() => core.switchAccount('ro'), /read-only/);
  });
});

describe('writeClaudeCode', () => {
  const live = () => ({
    json: { claudeAiOauth: { accessToken: 'old', subscriptionType: 'max', rateLimitTier: 'max_20x' } },
    source: { type: 'file', path: path.join(CFG, 'creds.json') },
  });

  it('merges by default', () => {
    const out = core.writeClaudeCode(live(), { accessToken: 'new' });
    assert.equal(out.json.claudeAiOauth.subscriptionType, 'max');
  });

  it('drops the previous account fields in replace mode', () => {
    const out = core.writeClaudeCode(live(), { accessToken: 'new' }, { replace: true });
    assert.equal(out.json.claudeAiOauth.subscriptionType, undefined);
    assert.equal(out.json.claudeAiOauth.accessToken, 'new');
  });
});

describe('oauth login session', () => {
  it('builds an authorize URL with the parameters Claude Code sends', async () => {
    const session = await core.beginLogin({});
    const url = new URL(session.authorizeUrl);
    assert.equal(url.origin + url.pathname, core.AUTHORIZE_URL);
    assert.equal(url.searchParams.get('code'), 'true');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${session.port}/callback`);
    assert.equal(url.searchParams.get('scope'), core.LOGIN_SCOPES_FULL);
    assert.ok(url.searchParams.get('state')?.length >= 40);
    assert.ok(url.searchParams.get('code_challenge')?.length >= 40);
    session.cancel();
    return session.waitForCode().catch(() => {});
  });

  it('requests only user:profile when read-only', async () => {
    const session = await core.beginLogin({ scopes: core.LOGIN_SCOPES_READONLY });
    assert.equal(new URL(session.authorizeUrl).searchParams.get('scope'), core.LOGIN_SCOPES_READONLY);
    session.cancel();
    return session.waitForCode().catch(() => {});
  });

  it('settles waitForCode when cancelled', async () => {
    const session = await core.beginLogin({});
    session.cancel();
    await assert.rejects(() => session.waitForCode(), (error) => error.code === 'ELOGINCANCELLED');
  });

  it('ignores a callback whose state does not match, and never echoes it back', async () => {
    const session = await core.beginLogin({});
    const res = await fetch(`http://localhost:${session.port}/callback?code=stray&state=WRONG`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('WRONG'));
    session.cancel();
    await session.waitForCode().catch(() => {});
  });

  it('never reflects attacker markup into the callback page', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    // A matching-state callback settles and closes the server, so use one per probe.
    for (const useRightState of [true, false]) {
      const session = await core.beginLogin({});
      const state = new URL(session.authorizeUrl).searchParams.get('state');
      const body = await (
        await fetch(
          `http://localhost:${session.port}/callback?error=${encodeURIComponent(payload)}&state=${useRightState ? encodeURIComponent(state) : 'WRONG'}`,
        )
      ).text();
      // The payload may be echoed, but only ever as inert escaped text.
      assert.ok(!body.includes(payload), body);
      assert.ok(!body.includes('<img'), body);
      assert.ok(!/<\s*script/i.test(body), body);
      session.cancel();
      await session.waitForCode().catch(() => {});
    }
  });

  it('completes a callback that carries the right state', async () => {
    const session = await core.beginLogin({});
    const state = new URL(session.authorizeUrl).searchParams.get('state');
    const res = await fetch(`http://localhost:${session.port}/callback?code=THECODE&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 200);
    assert.equal(await session.waitForCode(), 'THECODE');
  });
});

describe('usage windows', () => {
  const usage = {
    limits: [
      { kind: 'session', group: 'session', percent: 13, severity: 'normal', resets_at: '2026-08-31T12:59:59Z', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 60, severity: 'normal', resets_at: '2026-08-31T14:59:59Z', scope: null, is_active: false },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 99,
        severity: 'critical',
        resets_at: '2026-08-31T14:59:59Z',
        scope: { model: { id: null, display_name: 'Fable' } },
        is_active: true,
      },
    ],
  };

  it('reads every window from limits[], including the model-scoped one', () => {
    const windows = core.normalizeWindows(usage);
    assert.deepEqual(windows.map((w) => w.label), ['5h session', '7d all', '7d Fable']);
    assert.equal(windows[2].severity, 'critical');
  });

  it('falls back to top-level fields when limits[] is absent', () => {
    const windows = core.normalizeWindows({ five_hour: { utilization: 40, resets_at: '2026-08-31T12:00:00Z' } });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].percent, 40);
  });

  it('reports the worst weekly window as headroom', () => {
    assert.deepEqual(core.headroom(usage), { session: 13, weekly: 99 });
  });

  it('survives an empty or unknown response', () => {
    assert.deepEqual(core.normalizeWindows(null), []);
    assert.deepEqual(core.normalizeWindows({}), []);
  });
});

describe('loginHealth', () => {
  const day = 86400000;

  it('reports remaining lifetime', () => {
    const health = core.loginHealth({ record: { refreshTokenExpiresAt: Date.now() + 20 * day } });
    assert.equal(health.state, 'ok');
    assert.match(health.message, /valid for/);
  });

  it('warns close to expiry', () => {
    const health = core.loginHealth({ record: { refreshTokenExpiresAt: Date.now() + 2 * day } });
    assert.equal(health.state, 'expiring');
    assert.equal(health.action, 'login');
  });

  it('asks for a new login once lapsed', () => {
    assert.equal(core.loginHealth({ record: { refreshTokenExpiresAt: Date.now() - day } }).state, 'expired');
  });

  it('asks for a new login when the refresh token was rejected', () => {
    assert.equal(core.loginHealth({ record: {}, needsLogin: true }).state, 'expired');
  });

  it('says so when the lifetime is unknown', () => {
    assert.equal(core.loginHealth({ record: {} }).state, 'unknown');
  });
});

describe('formatting', () => {
  it('formats durations at each scale', () => {
    assert.equal(core.formatRelative(-5), 'now');
    assert.equal(core.formatRelative(90 * 1000), '2m');
    assert.equal(core.formatRelative(3 * 3600 * 1000), '3h 00m');
    assert.equal(core.formatRelative(50 * 3600 * 1000), '2d 2h');
  });

  it('clamps utilization into 0..100', () => {
    assert.equal(core.pct(-5), 0);
    assert.equal(core.pct(140), 100);
    assert.equal(core.pct(null), null);
    assert.equal(core.pct('42'), 42);
  });

  it('labels known subscription tiers', () => {
    assert.equal(core.tierLabel({ rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
    assert.equal(core.tierLabel({ rateLimitTier: 'default_claude_pro' }), 'Pro');
  });
});

describe('secret redaction', () => {
  it('strips token material from error text', () => {
    assert.equal(core.describeBody('failed: sk-ant-ort01-AbCdEf123456789'), 'failed: [redacted]');
    const header = core.describeBody('Authorization: Bearer sk-ant-oat01-XyZ987654321abcdef');
    assert.ok(!header.includes('sk-ant'), header);
    assert.ok(header.includes('[redacted]'), header);
  });

  it('strips tokens nested in an error body', () => {
    const body = { error: { message: 'bad code_verifier: dGVzdHZlcmlmaWVyMTIzNDU2Nzg5' } };
    assert.ok(!core.describeBody(body).includes('dGVzdHZlcmlmaWVy'));
  });

  it('leaves ordinary messages intact', () => {
    assert.equal(core.describeBody('Rate limited. Please try again later.'), 'Rate limited. Please try again later.');
  });
});

describe('token store', () => {
  it('round-trips a record with non-ASCII content', () => {
    core.tokenSet('unicode@x.com', { email: 'unicode@x.com', profile: { fullName: '북한산 Ünïcode' } });
    assert.equal(core.tokenGet('unicode@x.com').profile.fullName, '북한산 Ünïcode');
    core.tokenDelete('unicode@x.com');
    assert.equal(core.tokenGet('unicode@x.com'), null);
  });
});

describe('log scrubbing', () => {
  it('masks email addresses without losing the shape', () => {
    assert.equal(core.maskEmail('someone@company.example.com'), 's******@c***.com');
    assert.equal(core.maskEmail('a@b.io'), 'a*@b***.io');
  });

  it('leaves non-addresses alone', () => {
    assert.equal(core.maskEmail('not-an-address'), 'not-an-address');
  });

  it('scrubs both secrets and addresses from one line', () => {
    const line = 'refresh failed for admin@acme.co: Bearer sk-ant-ort01-AbCdEf123456789';
    const safe = core.scrub(line);
    assert.ok(!safe.includes('admin@acme.co'), safe);
    assert.ok(!safe.includes('sk-ant'), safe);
    assert.ok(safe.includes('a****@a***.co'), safe);
  });
});

describe('browser launch safety', () => {
  it('accepts the URLs the tool builds itself', async () => {
    const session = await core.beginLogin({ manual: true });
    assert.ok(core.isSafeBrowserUrl(session.authorizeUrl));
  });

  it('rejects non-https, foreign hosts and shell metacharacters', () => {
    assert.equal(core.isSafeBrowserUrl('http://claude.ai/oauth/authorize'), false);
    assert.equal(core.isSafeBrowserUrl('https://evil.example.com/oauth/authorize'), false);
    assert.equal(core.isSafeBrowserUrl('file:///etc/passwd'), false);
    assert.equal(core.isSafeBrowserUrl('not a url'), false);
    assert.equal(core.isSafeBrowserUrl('https://claude.ai/oauth/authorize?x="&calc'), false);
  });

  it('refuses to launch anything it did not build', () => {
    assert.equal(core.openBrowser('https://evil.example.com'), false);
  });
});

describe('oauth state binding', () => {
  it('refuses a pasted code carrying someone else\'s state', async () => {
    await assert.rejects(
      () => core.exchangeAuthorizationCode('somecode#attacker-state', 'our-state', 'verifier', 'https://example.com/cb'),
      /state mismatch/,
    );
  });

  it('refuses an empty code', async () => {
    await assert.rejects(() => core.exchangeAuthorizationCode('   ', 'our-state', 'v', 'https://example.com/cb'), /no authorization code/);
  });

  it('compares states in constant time and by exact value', () => {
    assert.equal(core.safeEqual('abc', 'abc'), true);
    assert.equal(core.safeEqual('abc', 'abd'), false);
    assert.equal(core.safeEqual('abc', 'abcd'), false);
    assert.equal(core.safeEqual('abc', undefined), false);
  });
});

describe('on-disk permissions', () => {
  it('writes the account index owner-only, even over a loose existing file', () => {
    core.saveIndex({ version: 1, accounts: [] });
    fs.chmodSync(core.INDEX_FILE, 0o644);
    core.saveIndex({ version: 1, accounts: [{ email: 'p@x.com', label: 'p' }] });
    assert.equal(fs.statSync(core.INDEX_FILE).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(core.INDEX_FILE)).mode & 0o777, 0o700);
  });

  it('writes the file token store owner-only', () => {
    core.tokenSet('perm@x.com', { email: 'perm@x.com', accessToken: 'x' });
    assert.equal(fs.statSync(core.FILE_STORE).mode & 0o777, 0o600);
    core.tokenDelete('perm@x.com');
  });

  it('leaves no temp files behind', () => {
    core.saveIndex({ version: 1, accounts: [] });
    const strays = fs.readdirSync(path.dirname(core.INDEX_FILE)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(strays, []);
  });
});

describe('usage request timing', () => {
  const email = 'timing@x.com';
  const record = () => ({ email, label: 't', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600e3 });
  const ok = () => new Response(JSON.stringify({ limits: [{ kind: 'session', percent: 1 }] }), { status: 200 });
  const throttled = () => new Response('Rate limited', { status: 429, headers: { 'retry-after': '0' } });
  let calls;
  let responder;
  const guardedFetch = globalThis.fetch;
  const resetCache = (content = {}) => {
    fs.mkdirSync(path.dirname(core.CACHE_FILE), { recursive: true });
    fs.writeFileSync(core.CACHE_FILE, JSON.stringify(content));
  };
  const readCache = () => JSON.parse(fs.readFileSync(core.CACHE_FILE, 'utf8'));

  before(() => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith(core.USAGE_URL)) throw new Error(`unexpected request: ${url}`);
      calls.push(Date.now());
      return responder();
    };
  });
  after(() => {
    globalThis.fetch = guardedFetch;
  });
  beforeEach(() => {
    calls = [];
    responder = ok;
    resetCache();
  });

  it('sends one request and answers later calls from the cache', async () => {
    const first = await core.fetchUsage(record(), null);
    assert.equal(first.fromCache, false);
    const second = await core.fetchUsage(record(), null);
    assert.equal(second.fromCache, true);
    assert.equal(second.stale, undefined);
    assert.equal(calls.length, 1);
  });

  it('coalesces concurrent calls for one account into a single request', async () => {
    const results = await Promise.all([1, 2, 3].map(() => core.fetchUsage(record(), null)));
    assert.equal(calls.length, 1);
    assert.equal(results.filter((r) => !r.fromCache).length, 1);
    assert.ok(results.every((r) => r.usage));
  });

  it('respects the spacing against a cache written by an older version', async () => {
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: Date.now() - 30e3, throttleRecoveryAt: 1 } });
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, true);
    assert.equal(calls.length, 0);
  });

  it('does not retry a failed request until the spacing has passed', async () => {
    responder = () => new Response('boom', { status: 503 });
    await assert.rejects(() => core.fetchUsage(record(), null), /503/);
    await assert.rejects(() => core.fetchUsage(record(), null), /503/);
    assert.equal(calls.length, 1);
  });

  it('goes quiet after a 429 and says when it will try again', async () => {
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: Date.now() - 10 * 60e3 } });
    responder = throttled;
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, true);
    assert.match(result.stale, /rate limited — next try in/);
    const again = await core.fetchUsage(record(), null);
    assert.match(again.stale, /rate limited/);
    assert.equal(calls.length, 1);
    const entry = readCache()[email];
    assert.ok(entry.limitedUntil - Date.now() > 9 * 60e3);
    assert.equal(entry.strikes, 1);
    assert.ok(entry.lastLimitedAt);
  });

  it('answers a second call within the spacing from the cache, unmarked', async () => {
    await core.fetchUsage(record(), null);
    const second = await core.fetchUsage(record(), null);
    assert.equal(second.fromCache, true);
    assert.equal(second.stale, undefined);
    assert.equal(calls.length, 1);
  });

  it('ignores the cooldown field an older cache file may still carry', async () => {
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: Date.now() - 30 * 60e3, attemptedAt: Date.now() - 30 * 60e3, cooldownUntil: Date.now() + 5 * 60e3, holdUntil: Date.now() + 5 * 60e3 } });
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, false);
    assert.equal(calls.length, 1);
  });

  it('polls an account throttled within the last hour half as often', async () => {
    const sixMinutes = Date.now() - 6 * 60e3;
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: sixMinutes, attemptedAt: sixMinutes, lastLimitedAt: Date.now() - 30 * 60e3 } });
    assert.equal((await core.fetchUsage(record(), null)).fromCache, true);
    assert.equal(calls.length, 0);
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: sixMinutes, attemptedAt: sixMinutes, lastLimitedAt: Date.now() - 2 * 3600e3 } });
    assert.equal((await core.fetchUsage(record(), null)).fromCache, false);
    assert.equal(calls.length, 1);
  });

  it('blocks during the cooldown even with nothing cached to show', async () => {
    responder = throttled;
    await assert.rejects(() => core.fetchUsage(record(), null), /rate limited/);
    await assert.rejects(() => core.fetchUsage(record(), null), /rate limited/);
    assert.equal(calls.length, 1);
  });

  it('doubles the cooldown on consecutive 429s and clears it on success', async () => {
    const long = Date.now() - 30 * 60e3;
    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: long, attemptedAt: long, strikes: 1, limitedUntil: Date.now() - 1 } });
    responder = throttled;
    await core.fetchUsage(record(), null);
    let entry = readCache()[email];
    assert.equal(entry.strikes, 2);
    assert.ok(entry.limitedUntil - Date.now() > 19 * 60e3);

    resetCache({ [email]: { usage: { limits: [] }, fetchedAt: long, attemptedAt: long, strikes: 2, lastError: 'rate limited', lastLimitedAt: long, limitedUntil: long } });
    responder = ok;
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, false);
    entry = readCache()[email];
    assert.equal(entry.strikes, undefined);
    assert.equal(entry.limitedUntil, undefined);
    assert.equal(entry.lastError, undefined);
    assert.equal(entry.lastLimitedAt, long);
  });

  it('staggers requests for different accounts', async () => {
    const other = { ...record(), email: 'other@x.com' };
    await core.fetchUsage(record(), null);
    await core.fetchUsage(other, null);
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= core.ACCOUNT_STAGGER_MS - 20, `${calls[1] - calls[0]}ms apart`);
  });

  it('fetches every account of a collect() at once, sends staggered, order kept', async () => {
    const emails = ['c1@x.com', 'c2@x.com', 'c3@x.com'];
    core.saveIndex({ version: 1, accounts: emails.map((e) => ({ email: e, label: e.split('@')[0] })) });
    for (const e of emails) core.tokenSet(e, { ...record(), email: e });
    let slow = 0;
    responder = () => {
      slow += 1;
      // A slow first reply must not hold the others back.
      return slow === 1 ? new Promise((resolve) => setTimeout(() => resolve(ok()), 4 * core.ACCOUNT_STAGGER_MS)) : ok();
    };
    const started = Date.now();
    const { results } = await core.collect({ sync: false });
    const elapsed = Date.now() - started;
    assert.deepEqual(results.map((r) => r.record.email), emails);
    assert.ok(results.every((r) => r.usage && !r.error), JSON.stringify(results.map((r) => r.error)));
    assert.equal(calls.length, 3);
    const gaps = calls.slice(1).map((t, i) => t - calls[i]);
    assert.ok(gaps.every((g) => g >= core.ACCOUNT_STAGGER_MS - 20), `gaps ${gaps.join(', ')}ms`);
    // Sequential would be ≥ 4 + 1 + 1 staggers; overlapped, the slow reply sets the pace.
    assert.ok(elapsed < 5.5 * core.ACCOUNT_STAGGER_MS, `took ${elapsed}ms`);
    for (const e of emails) core.tokenDelete(e);
  });

  it('recovers a lock left behind by a dead process', async () => {
    fs.writeFileSync(core.CACHE_LOCK_FILE, '0');
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(core.CACHE_LOCK_FILE, old, old);
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, false);
    assert.equal(fs.existsSync(core.CACHE_LOCK_FILE), false);
  });

  it('writes the cache owner-only', async () => {
    await core.fetchUsage(record(), null);
    assert.equal(fs.statSync(core.CACHE_FILE).mode & 0o777, 0o600);
  });
});

// ── Codex ───────────────────────────────────────────────────────────────────

/** A JWT with the claims OpenAI's id_token carries; the signature is irrelevant here. */
function fakeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.sig`;
}

const CODEX_AUTH_FILE = path.join(process.env.CODEX_HOME, 'auth.json');

function writeCodexAuthFixture({ email = 'me@openai.example', plan = 'pro', accountId = 'acct-1', exp = Math.floor(Date.now() / 1000) + 10 * 86400, refresh = 'rt.1.AAAAoldrefreshtoken000', lastRefresh = '2026-09-09T05:16:03.431839Z' } = {}) {
  const auth = { chatgpt_account_id: accountId, chatgpt_plan_type: plan, chatgpt_user_id: 'user-1' };
  const idToken = fakeJwt({ email, 'https://api.openai.com/auth': auth, exp });
  const accessToken = fakeJwt({ 'https://api.openai.com/auth': auth, exp });
  fs.mkdirSync(path.dirname(CODEX_AUTH_FILE), { recursive: true });
  fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: accessToken, refresh_token: refresh, account_id: accountId },
    last_refresh: lastRefresh,
  }));
  return { idToken, accessToken, refresh, accountId, email };
}

describe('codex identity', () => {
  it('reads the address and plan out of the id_token without a network call', () => {
    const { idToken } = writeCodexAuthFixture({ email: 'who@openai.example', plan: 'plus' });
    const identity = core.codexIdentity({ id_token: idToken, account_id: 'acct-1' });
    assert.deepEqual(identity, { email: 'who@openai.example', accountId: 'acct-1', planType: 'plus', userId: 'user-1' });
  });

  it('falls back to the profile claim for the address', () => {
    const jwt = fakeJwt({ 'https://api.openai.com/profile': { email: 'p@openai.example' } });
    assert.equal(core.codexIdentity({ id_token: jwt }).email, 'p@openai.example');
  });

  it('survives garbage instead of a token', () => {
    assert.equal(core.decodeJwtClaims('not.a.jwt'), null);
    assert.equal(core.decodeJwtClaims(undefined), null);
    assert.deepEqual(core.codexIdentity({ id_token: 'x' }), {});
  });

  it('labels ChatGPT plans', () => {
    assert.equal(core.tierLabel({ provider: 'codex', planType: 'pro' }), 'ChatGPT Pro');
    assert.equal(core.tierLabel({ provider: 'codex', planType: 'team' }), 'ChatGPT Team');
    assert.equal(core.tierLabel({ provider: 'codex' }), 'ChatGPT');
  });

  it('describes a Codex login as active, since OpenAI publishes no lifetime', () => {
    const health = core.loginHealth({ record: { provider: 'codex', lastRefresh: Date.now() - 3600e3 } });
    assert.equal(health.state, 'ok');
    assert.match(health.message, /refreshed 1h 00m ago/);
    assert.equal(core.loginHealth({ record: { provider: 'codex' }, needsLogin: true }).state, 'expired');
  });
});

describe('codex auth.json', () => {
  it('captures the account Codex is signed in as and namespaces its token', async () => {
    const fixture = writeCodexAuthFixture({ email: 'cap@openai.example', plan: 'pro' });
    core.saveIndex({ version: 1, accounts: [] });
    const saved = await core.captureFromCodex({ label: 'cap' });
    assert.equal(saved.provider, 'codex');
    assert.equal(saved.email, 'cap@openai.example');
    assert.deepEqual(core.loadIndex().accounts.map((a) => [a.provider, a.email, a.label]), [['codex', 'cap@openai.example', 'cap']]);
    assert.equal(core.tokenGet('cap@openai.example'), null, 'a Codex token must not sit under the bare email');
    const record = core.tokenGet('codex:cap@openai.example');
    assert.equal(record.accessToken, fixture.accessToken);
    assert.equal(record.refreshToken, fixture.refresh);
    assert.equal(record.accountId, 'acct-1');
    assert.equal(record.planType, 'pro');
    assert.equal(record.source, 'codex-cli');
    assert.equal(record.lastRefresh, Date.parse('2026-09-09T05:16:03.431839Z'));
    assert.ok(record.expiresAt > Date.now() + 9 * 86400e3, 'expiry comes from the access token');
  });

  it('keeps a Claude and a Codex account with the same address apart', async () => {
    core.saveIndex({ version: 1, accounts: [{ email: 'same@x.com', label: 'work' }, { email: 'same@x.com', label: 'work', provider: 'codex' }] });
    core.tokenSet('same@x.com', { email: 'same@x.com', accessToken: 'claude-token' });
    core.tokenSet('codex:same@x.com', { email: 'same@x.com', accessToken: 'codex-token' });
    const records = core.loadRecords();
    assert.deepEqual(records.map((r) => [r.provider, r.accessToken]), [['claude', 'claude-token'], ['codex', 'codex-token']]);
    assert.throws(() => core.findAccount('same@x.com'), /codex:same@x.com or claude:same@x.com/);
    assert.equal(core.findAccount('codex:work').provider, 'codex');
    assert.equal(core.findAccount('work', { provider: 'claude' }).provider, 'claude');
    assert.equal(core.removeAccount('codex:same@x.com').provider, 'codex');
    assert.equal(core.tokenGet('codex:same@x.com'), null);
    assert.equal(core.tokenGet('same@x.com').accessToken, 'claude-token');
    core.tokenDelete('same@x.com');
  });

  it('adopts a newer token pair that Codex rotated on its own', () => {
    core.saveIndex({ version: 1, accounts: [{ email: 'rot@openai.example', label: 'rot', provider: 'codex' }] });
    core.tokenSet('codex:rot@openai.example', { provider: 'codex', email: 'rot@openai.example', accessToken: 'stale', refreshToken: 'rt.1.stale', lastRefresh: Date.parse('2026-09-01T00:00:00Z') });
    const fixture = writeCodexAuthFixture({ email: 'rot@openai.example', refresh: 'rt.1.AAAAnewer0000000', lastRefresh: '2026-09-10T00:00:00Z' });
    const { liveEmail, records } = core.syncFromCodex(core.loadRecords());
    assert.equal(liveEmail, 'rot@openai.example');
    assert.equal(records[0].accessToken, fixture.accessToken);
    assert.equal(core.tokenGet('codex:rot@openai.example').refreshToken, 'rt.1.AAAAnewer0000000');
    // An older pair on disk is left alone.
    writeCodexAuthFixture({ email: 'rot@openai.example', refresh: 'rt.1.AAAAolder0000000', lastRefresh: '2026-08-01T00:00:00Z' });
    assert.equal(core.syncFromCodex(core.loadRecords()).records[0].refreshToken, 'rt.1.AAAAnewer0000000');
  });

  it('switches Codex by rewriting auth.json the way `codex login` does, keeping other fields', async () => {
    writeCodexAuthFixture({ email: 'old@openai.example', refresh: 'rt.1.AAAAoldaccount000' });
    const extra = { ...JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8')), some_future_field: true };
    fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(extra));
    const idToken = fakeJwt({ email: 'new@openai.example', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new', chatgpt_plan_type: 'plus' }, exp: Math.floor(Date.now() / 1000) + 86400 });
    core.saveIndex({ version: 1, accounts: [{ email: 'new@openai.example', label: 'new', provider: 'codex' }] });
    core.tokenSet('codex:new@openai.example', { provider: 'codex', email: 'new@openai.example', accessToken: 'acc-new', refreshToken: 'rt.1.AAAAnewaccount000', idToken, accountId: 'acct-new', expiresAt: Date.now() + 86400e3, lastRefresh: Date.now() - 1000 });
    const result = await core.switchAccount('new', { provider: 'codex' });
    assert.equal(result.alreadyActive, false);
    assert.equal(result.untrackedReplaced, 'old@openai.example');
    const written = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8'));
    assert.equal(written.auth_mode, 'chatgpt');
    assert.equal(written.OPENAI_API_KEY, null);
    assert.equal(written.some_future_field, true);
    assert.deepEqual(written.tokens, { id_token: idToken, access_token: 'acc-new', refresh_token: 'rt.1.AAAAnewaccount000', account_id: 'acct-new' });
    assert.match(written.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.statSync(CODEX_AUTH_FILE).mode & 0o777, 0o600);
    assert.equal((await core.switchAccount('codex:new')).alreadyActive, true);
    fs.rmSync(CODEX_AUTH_FILE, { force: true });
  });

  it('refuses a non-ChatGPT Codex login', async () => {
    writeCodexAuthFixture();
    const json = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8'));
    fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify({ ...json, auth_mode: 'apikey' }));
    await assert.rejects(() => core.captureFromCodex(), /not a ChatGPT login/);
    fs.rmSync(CODEX_AUTH_FILE, { force: true });
  });
});

describe('codex login session', () => {
  it('builds the authorize URL the Codex CLI sends, on one of its registered ports', async () => {
    const session = await core.beginLogin({ provider: 'codex' });
    const url = new URL(session.authorizeUrl);
    assert.equal(url.origin + url.pathname, core.CODEX_AUTHORIZE_URL);
    assert.equal(url.searchParams.get('client_id'), core.CODEX_CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), core.CODEX_LOGIN_SCOPES);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
    assert.ok(core.CODEX_CALLBACK_PORTS.includes(session.port));
    assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${session.port}/auth/callback`);
    assert.ok(core.isSafeBrowserUrl(session.authorizeUrl));
    session.cancel();
    await session.waitForCode().catch(() => {});
  });

  it('answers the Codex callback path and completes with the code', async () => {
    const session = await core.beginLogin({ provider: 'codex' });
    const state = new URL(session.authorizeUrl).searchParams.get('state');
    const wrongPath = await fetch(`http://localhost:${session.port}/callback?code=x&state=${encodeURIComponent(state)}`);
    assert.equal(wrongPath.status, 404);
    const res = await fetch(`http://localhost:${session.port}/auth/callback?code=CODEXCODE&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 200);
    assert.equal(await session.waitForCode(), 'CODEXCODE');
  });

  it('has no paste-the-code flow', async () => {
    await assert.rejects(() => core.beginLogin({ provider: 'codex', manual: true }), /localhost/);
  });
});

describe('codex usage windows', () => {
  const at = (seconds) => Math.floor(Date.now() / 1000) + seconds;
  const usage = {
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_after_seconds: 7000, reset_at: at(7000) },
      secondary_window: { used_percent: 71, limit_window_seconds: 604800, reset_after_seconds: 400000, reset_at: at(400000) },
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: at(18000) },
          secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: at(604800) },
        },
      },
    ],
    credits: { has_credits: false, unlimited: false, balance: '0' },
  };

  it('recognises the /wham/usage shape', () => {
    assert.equal(core.isCodexUsage(usage), true);
    assert.equal(core.isCodexUsage({ limits: [] }), false);
    assert.equal(core.isCodexUsage({ five_hour: { utilization: 1 } }), false);
  });

  it('names windows by their length and leaves the per-model side limits out', () => {
    const windows = core.normalizeWindows(usage);
    assert.deepEqual(windows.map((w) => [w.label, w.group, w.percent, w.severity]), [
      ['5h session', 'session', 32, null],
      ['7d all', 'weekly', 71, 'warning'],
    ]);
    assert.equal(windows[0].resetsAt, new Date(usage.rate_limit.primary_window.reset_at * 1000).toISOString());
    assert.deepEqual(core.headroom(usage), { session: 32, weekly: 71 });
  });

  it('reports a spent weekly limit as locked when only that window is returned', () => {
    // Once the weekly limit is reached the backend reports it as the primary window and omits the 5h one.
    const spent = {
      plan_type: 'pro',
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 1, reset_at: at(1) }, secondary_window: null },
    };
    const windows = core.normalizeWindows(spent);
    assert.deepEqual(windows.map((w) => [w.label, w.group, w.severity]), [['7d all', 'weekly', 'locked']]);
  });

  it('derives the reset time from reset_after_seconds when reset_at is absent', () => {
    const windows = core.normalizeWindows({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 600 } } });
    assert.ok(Math.abs(new Date(windows[0].resetsAt).getTime() - (Date.now() + 600e3)) < 2000);
  });
});

describe('codex secret redaction', () => {
  it('strips OpenAI refresh tokens and API keys', () => {
    assert.equal(core.redact('refresh_token=rt.1.AAC4EYOabcdefghijklmnop failed'), 'refresh_token=[redacted] failed');
    assert.equal(core.redact('key sk-proj-abcdefghijklmnopqrstuvwxyz0123'), 'key [redacted]');
  });
});

describe('codex usage request', () => {
  const record = () => ({ provider: 'codex', email: 'cx@openai.example', label: 'cx', accessToken: 'tok', refreshToken: 'rt.1.x', accountId: 'acct-1', expiresAt: Date.now() + 3600e3 });
  const guardedFetch = globalThis.fetch;
  let seen;
  before(() => {
    fs.mkdirSync(path.dirname(core.CACHE_FILE), { recursive: true });
    fs.writeFileSync(core.CACHE_FILE, '{}');
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(core.CODEX_USAGE_URL)) throw new Error(`unexpected request: ${url}`);
      seen = init;
      return new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 9, limit_window_seconds: 18000, reset_at: 1 } } }), { status: 200 });
    };
  });
  after(() => {
    globalThis.fetch = guardedFetch;
  });

  it('calls /wham/usage with the bearer and the workspace header, and caches under the namespaced key', async () => {
    const result = await core.fetchUsage(record(), null);
    assert.equal(result.fromCache, false);
    assert.equal(seen.headers.Authorization, 'Bearer tok');
    assert.equal(seen.headers['ChatGPT-Account-Id'], 'acct-1');
    assert.equal(seen.headers['anthropic-beta'], undefined);
    const cache = JSON.parse(fs.readFileSync(core.CACHE_FILE, 'utf8'));
    assert.ok(cache['codex:cx@openai.example']?.usage);
    assert.equal(cache['cx@openai.example'], undefined);
    assert.equal(core.normalizeWindows(result.usage)[0].label, '5h session');
  });
});
