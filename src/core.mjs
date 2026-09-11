import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const AUTHORIZE_URL_CONSOLE = 'https://platform.claude.com/oauth/authorize';
export const LOGIN_SCOPES_FULL = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const LOGIN_SCOPES_READONLY = 'user:profile';
export const CALLBACK_PORT = 54545;
export const CALLBACK_PATH = '/callback';
export const MANUAL_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const USER_AGENT = 'multi-account-usage-bar/1.2';

// Codex (OpenAI) — the ChatGPT login the Codex CLI uses. Same shape as the Claude
// side: PKCE sign-in, a rotating refresh token, and a usage endpoint that reports a
// short and a weekly window. Values match codex-rs (login/src/server.rs,
// login/src/auth/manager.rs, backend-client/src/client/rate_limit_resets.rs).
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_LOGIN_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
/** OpenAI registers exactly these two loopback redirect ports for the Codex client. */
export const CODEX_CALLBACK_PORTS = [1455, 1457];
export const CODEX_CALLBACK_PATH = '/auth/callback';
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_AUTH_FILE = path.join(CODEX_HOME, 'auth.json');
/** Codex itself refreshes a login untouched for this long; used when a token carries no `exp`. */
const CODEX_TOKEN_LIFETIME_MS = 8 * 86400000;

export const PROVIDERS = ['claude', 'codex'];
export const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };
/** What the provider's own CLI is called — "active in Claude Code" / "active in Codex". */
export const PROVIDER_CLIENTS = { claude: 'Claude Code', codex: 'Codex' };
const PROVIDER_VENDORS = { claude: 'Anthropic', codex: 'OpenAI' };
const CODEX_PLAN_NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

const CLAUDE_KEYCHAIN_SERVICE = process.env.USAGE_BAR_CLAUDE_SERVICE || process.env.CLAUDE_USAGE_CLAUDE_SERVICE || 'Claude Code-credentials';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_GLOBAL_CONFIG = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json');

// Every `USAGE_BAR_*` variable also answers to its pre-rename `CLAUDE_USAGE_*` spelling.
export const STORE_SERVICE = 'multi-account-usage-bar';
export const CONFIG_DIR = process.env.USAGE_BAR_CONFIG_DIR || process.env.CLAUDE_USAGE_CONFIG_DIR || path.join(os.homedir(), '.config', 'multi-account-usage-bar');
// Where 1.x (as "claude-usage-monitor") kept the same data; moved across on first use.
const LEGACY_STORE_SERVICE = 'claude-usage-monitor';
const LEGACY_CONFIG_DIR = process.env.USAGE_BAR_LEGACY_CONFIG_DIR || path.join(os.homedir(), '.config', 'claude-usage-monitor');
export const INDEX_FILE = path.join(CONFIG_DIR, 'accounts.json');
export const FILE_STORE = path.join(CONFIG_DIR, 'tokens.json');
export const CACHE_FILE = path.join(CONFIG_DIR, 'usage-cache.json');
export const CACHE_LOCK_FILE = path.join(CONFIG_DIR, 'usage-cache.lock');

// Request timing. The usage endpoint throttles per access token and, once tripped,
// stays tripped for as long as you keep asking (measured: six minutes of 10s polling
// never cleared it; ~2 minutes of silence did). Several front ends run at once — the
// CLI, `watch`, the menu bar app — and each used to poll on its own clock, so the
// rate the endpoint saw was the sum of all of them. Every figure below is therefore
// enforced through the shared cache file under a lock, so it holds across every
// process on the machine, not just inside one.
/**
 * Never send two usage requests for the same account closer together than this.
 * Measured 2026-09-02: two pollers at ~90s between them still tripped a 429 within
 * minutes, so the floor sits well above that.
 */
export const MIN_FETCH_SPACING_MS = 300 * 1000;
/** An account the endpoint throttled within this long is polled at twice the spacing. */
export const LIMITED_MEMORY_MS = 60 * 60 * 1000;
/** Never send usage requests for two different accounts closer together than this. */
export const ACCOUNT_STAGGER_MS = 2 * 1000;
/** After a 429: send nothing for this long, doubling on each consecutive 429 … */
export const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
/** … up to this. */
export const RATE_LIMIT_COOLDOWN_MAX_MS = 60 * 60 * 1000;
/** A failed profile lookup of Claude Code's live token is not retried sooner than this. */
export const PROFILE_RETRY_SPACING_MS = 10 * 60 * 1000;
// Front ends poll on timers equal to the spacing; a tick that lands a moment early
// must not push that account's next read a whole cycle back.
const SPACING_TOLERANCE_MS = 5 * 1000;
// Another process claimed the slot and is mid-request: how long to wait for its
// result before giving up on this round.
const INFLIGHT_WAIT_MS = 20 * 1000;
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 15 * 1000;
const MACHINE_KEY = '$machine';
const PROFILE_KEY = '$profile';
export const USE_KEYCHAIN = process.platform === 'darwin' && (process.env.USAGE_BAR_STORE ?? process.env.CLAUDE_USAGE_STORE) !== 'file';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const WINDOW_LABELS = {
  five_hour: '5h',
  seven_day: '7d all',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  seven_day_oauth_apps: '7d OAuth apps',
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

export const PROFILE_FIELDS = [
  'accountUuid',
  'emailAddress',
  'displayName',
  'fullName',
  'organizationUuid',
  'organizationName',
  'organizationType',
  'organizationRole',
  'organizationRateLimitTier',
  'billingType',
];

let warnHandler = (message) => process.stderr.write(`warn: ${message}\n`);
let infoHandler = () => {};

export function setLogger({ onWarn, onInfo } = {}) {
  if (onWarn) warnHandler = onWarn;
  if (onInfo) infoHandler = onInfo;
}

function warn(message) {
  warnHandler(message);
}

export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== null));
}

// Anything token-shaped must never survive into a message a user might paste into
// an issue: `sk-ant-…` credentials, bare OAuth grants, and Bearer headers.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9._-]+/g,
  /\bsk-[A-Za-z0-9._-]{16,}/g,
  /\brt\.[0-9]+\.[A-Za-z0-9._~+/-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:eyJ[A-Za-z0-9._-]{10,})/g,
  /\b(?:access|refresh|id)[_-]?token"?\s*[:=]\s*"?[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bcode_verifier"?\s*[:=]\s*"?[A-Za-z0-9._~-]{8,}/gi,
];

/** Every index entry and record carries a provider; entries written before 1.2 mean Claude. */
export function accountProvider(entry) {
  return entry?.provider === 'codex' ? 'codex' : 'claude';
}

export function providerName(entry) {
  return PROVIDER_NAMES[accountProvider(entry)];
}

/**
 * The name a token record is stored under. Claude accounts keep their bare email so
 * stores written by earlier versions still resolve; Codex accounts are namespaced,
 * because one address can hold both a Claude and a ChatGPT subscription.
 */
export function storeKey(entry) {
  return accountProvider(entry) === 'codex' ? `codex:${entry.email}` : entry.email;
}

/** Strip credential-shaped substrings from any text headed for a log, error or terminal. */
export function redact(text) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Mask an email for logs — the account stays identifiable, the address does not leak. */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot === -1 ? '' : domain.slice(dot);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}@${domain.slice(0, 1)}***${tld}`;
}

/** Redact secrets and mask any address before text reaches a log file. */
export function scrub(text) {
  return redact(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskEmail(match));
}

export function describeBody(body) {
  if (typeof body === 'string') return redact(body.slice(0, 200));
  if (body && typeof body === 'object') {
    return redact(body.error?.message || body.error_description || body.error || JSON.stringify(body).slice(0, 200));
  }
  return redact(String(body));
}

function security(args) {
  return spawnSync('security', args, { encoding: 'utf8' });
}

function decodeKeychainSecret(raw) {
  if (raw.length < 2 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'hex').toString('utf8');
  return decoded.includes('�') ? raw : decoded;
}

function keychainRead(service, account) {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  args.push('-w');
  const result = security(args);
  if (result.status !== 0) return null;
  return decodeKeychainSecret(result.stdout.replace(/\n$/, ''));
}

function keychainAccountName(service) {
  const result = security(['find-generic-password', '-s', service]);
  if (result.status !== 0) return null;
  const match = result.stdout.match(/"acct"<blob>="([^"]*)"/);
  return match ? match[1] : null;
}

// `security` takes the secret as an argv value, which is readable via `ps` by other
// processes of the same user for the moment the write runs. The prompt form (`-w`
// with no value) reads stdin but truncates at 128 bytes, far below a token record,
// so argv is the only workable path through this CLI. It is not the weak link:
// any same-user process can already read these items back with `security` itself,
// because the item's ACL trusts that binary. See "What Keychain storage does and
// does not protect" in SECURITY.md.
function keychainWrite(service, account, secret) {
  const result = security(['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret]);
  if (result.status !== 0) throw new Error(`keychain write failed: ${redact(result.stderr.trim())}`);
}

function keychainDelete(service, account) {
  security(['delete-generic-password', '-s', service, '-a', account]);
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Write owner-only, and atomically: a half-written token store is a lost login, and
 * `mode` on writeFileSync only applies when the file is created — an existing file
 * keeps whatever permissions it already had, so set them explicitly every time.
 */
function writePrivateFile(file, text, { ownDir = true } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Another tool's directory (~/.codex) keeps whatever mode it has; only ours is tightened.
  if (ownDir) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* not ours to tighten (e.g. a shared parent) — the file mode below still holds */
    }
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function writePrivateJson(file, data) {
  writePrivateFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Carry a 1.x store over to the new name: the account index, the cache, and every
 * token (Keychain items under the old service, or tokens.json). Copies first and
 * removes the old copies only once the new ones read back, so an interruption can
 * at worst leave both in place — never neither.
 */
function migrateLegacyStore() {
  const legacyIndex = path.join(LEGACY_CONFIG_DIR, 'accounts.json');
  if (path.resolve(LEGACY_CONFIG_DIR) === path.resolve(CONFIG_DIR) || fs.existsSync(INDEX_FILE) || !fs.existsSync(legacyIndex)) return false;
  const index = readJsonFile(legacyIndex, null);
  if (!Array.isArray(index?.accounts)) return false;
  const legacyFileStore = path.join(LEGACY_CONFIG_DIR, 'tokens.json');
  const moved = [];
  if (USE_KEYCHAIN) {
    for (const entry of index.accounts) {
      const key = storeKey(entry);
      const raw = keychainRead(LEGACY_STORE_SERVICE, key);
      if (raw === null) continue;
      keychainWrite(STORE_SERVICE, key, raw);
      if (keychainRead(STORE_SERVICE, key) === raw) moved.push(key);
    }
  } else if (fs.existsSync(legacyFileStore)) {
    writePrivateJson(FILE_STORE, readJsonFile(legacyFileStore, {}));
  }
  const legacyCache = readJsonFile(path.join(LEGACY_CONFIG_DIR, 'usage-cache.json'), null);
  if (legacyCache && typeof legacyCache === 'object') writePrivateJson(CACHE_FILE, legacyCache);
  writePrivateJson(INDEX_FILE, index);
  // Only now retire the old copies.
  for (const key of moved) keychainDelete(LEGACY_STORE_SERVICE, key);
  for (const name of ['accounts.json', 'usage-cache.json', 'usage-cache.lock', 'tokens.json']) {
    fs.rmSync(path.join(LEGACY_CONFIG_DIR, name), { force: true });
  }
  try {
    fs.rmdirSync(LEGACY_CONFIG_DIR);
  } catch {
    /* something else in there — leave the directory */
  }
  infoHandler(`moved ${index.accounts.length} account(s) from ${LEGACY_CONFIG_DIR} to ${CONFIG_DIR}`);
  return true;
}

export function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    try {
      migrateLegacyStore();
    } catch (error) {
      warn(`could not move the 1.x account store to ${CONFIG_DIR}: ${error.message}`);
    }
  }
  if (!fs.existsSync(INDEX_FILE)) return { version: 1, accounts: [] };
  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`account index at ${INDEX_FILE} is unreadable (${error.message}) — move it aside and re-add accounts; stored tokens are untouched`);
  }
  if (!Array.isArray(index?.accounts)) throw new Error(`account index at ${INDEX_FILE} has no accounts list — move it aside and re-add accounts`);
  return index;
}

export function saveIndex(index) {
  writePrivateJson(INDEX_FILE, index);
}

export function tokenGet(email) {
  if (USE_KEYCHAIN) {
    const raw = keychainRead(STORE_SERVICE, email);
    return raw ? readJsonText(raw) : null;
  }
  return readJsonFile(FILE_STORE, {})[email] ?? null;
}

export function tokenSet(email, record) {
  if (USE_KEYCHAIN) {
    keychainWrite(STORE_SERVICE, email, JSON.stringify(record));
    return;
  }
  const store = readJsonFile(FILE_STORE, {});
  store[email] = record;
  writePrivateJson(FILE_STORE, store);
}

export function tokenDelete(email) {
  if (USE_KEYCHAIN) {
    keychainDelete(STORE_SERVICE, email);
    return;
  }
  const store = readJsonFile(FILE_STORE, {});
  delete store[email];
  writePrivateJson(FILE_STORE, store);
}

export function storageDescription() {
  return USE_KEYCHAIN ? `macOS Keychain (service "${STORE_SERVICE}")` : FILE_STORE;
}

export function readClaudeCode() {
  const file = path.join(CLAUDE_CONFIG_DIR, '.credentials.json');
  const fromFile = readJsonFile(file, null);
  if (fromFile?.claudeAiOauth?.accessToken) {
    return { json: fromFile, source: { type: 'file', path: file } };
  }
  if (process.platform === 'darwin') {
    const raw = keychainRead(CLAUDE_KEYCHAIN_SERVICE);
    const json = raw ? readJsonText(raw) : null;
    if (json?.claudeAiOauth?.accessToken) {
      const account = keychainAccountName(CLAUDE_KEYCHAIN_SERVICE) || os.userInfo().username;
      return { json, source: { type: 'keychain', service: CLAUDE_KEYCHAIN_SERVICE, account } };
    }
  }
  return null;
}

export function writeClaudeCode(live, patch, { replace = false } = {}) {
  const base = live?.json ?? { claudeAiOauth: {} };
  const json = { ...base, claudeAiOauth: replace ? { ...patch } : { ...base.claudeAiOauth, ...patch } };
  const text = JSON.stringify(json);
  const source = live?.source ?? {
    type: process.platform === 'darwin' ? 'keychain' : 'file',
    service: CLAUDE_KEYCHAIN_SERVICE,
    account: os.userInfo().username,
    path: path.join(CLAUDE_CONFIG_DIR, '.credentials.json'),
  };
  if (source.type === 'file') {
    // ~/.claude is Claude Code's directory: the file is written owner-only, the directory is left as is.
    writePrivateFile(source.path, text, { ownDir: false });
  } else keychainWrite(source.service, source.account, text);
  return { json, source };
}

export function readClaudeGlobalConfig() {
  return readJsonFile(CLAUDE_GLOBAL_CONFIG, null);
}

/** The payload of a JWT, unverified — used only to read the identity our own login returned. */
export function decodeJwtClaims(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

function jwtExpiry(jwt) {
  const exp = decodeJwtClaims(jwt)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/**
 * Who a Codex token pair belongs to. The id_token carries the address and the
 * ChatGPT workspace/plan, so unlike Claude this never needs a network round trip.
 * Accepts either auth.json's `tokens` block or one of our records.
 */
export function codexIdentity(tokens) {
  const claims = decodeJwtClaims(tokens?.idToken ?? tokens?.id_token) ?? {};
  const auth = claims['https://api.openai.com/auth'] ?? {};
  const email = claims.email ?? claims['https://api.openai.com/profile']?.email ?? null;
  return compact({
    email: typeof email === 'string' ? email : null,
    accountId: tokens?.accountId ?? tokens?.account_id ?? auth.chatgpt_account_id,
    planType: auth.chatgpt_plan_type,
    userId: auth.chatgpt_user_id ?? auth.user_id,
  });
}

/** Codex's login as its CLI stores it: $CODEX_HOME/auth.json (ChatGPT mode only). */
export function readCodexAuth() {
  const json = readJsonFile(CODEX_AUTH_FILE, null);
  if (!json?.tokens?.access_token) return null;
  return { json, source: { type: 'file', path: CODEX_AUTH_FILE } };
}

/** Our record fields for the tokens auth.json holds. */
function codexWorkingFromLive(live) {
  const tokens = live.json.tokens;
  const lastRefresh = live.json.last_refresh ? Date.parse(live.json.last_refresh) : NaN;
  return compact({
    provider: 'codex',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : undefined,
    expiresAt: jwtExpiry(tokens.access_token) ?? (Number.isFinite(lastRefresh) ? lastRefresh + CODEX_TOKEN_LIFETIME_MS : undefined),
    ...codexIdentity(tokens),
  });
}

/**
 * Write a token pair into auth.json the way `codex login` does, keeping every other
 * field the file has. Atomic like our own files, but the directory belongs to Codex.
 */
export function writeCodexAuth(live, working) {
  const base = live?.json ?? {};
  const file = live?.source?.path ?? CODEX_AUTH_FILE;
  const json = {
    ...base,
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: base.OPENAI_API_KEY ?? null,
    tokens: compact({
      id_token: working.idToken,
      access_token: working.accessToken,
      refresh_token: working.refreshToken,
      account_id: working.accountId,
    }),
    last_refresh: new Date(working.lastRefresh ?? Date.now()).toISOString(),
  };
  writePrivateFile(file, `${JSON.stringify(json, null, 2)}\n`, { ownDir: false });
  return { json, source: { type: 'file', path: file } };
}

export function updateClaudeGlobalAccount(profile) {
  const config = readClaudeGlobalConfig();
  if (!config || !config.oauthAccount || typeof config.oauthAccount !== 'object') return false;
  const next = { ...config.oauthAccount };
  for (const key of PROFILE_FIELDS) {
    if (profile[key] !== undefined) next[key] = profile[key];
  }
  next.profileFetchedAt = Date.now();
  // ~/.claude.json is Claude Code's own config and holds far more than this account
  // block — replace it atomically, keeping its existing permissions, so an interrupted
  // write can never truncate it.
  const text = JSON.stringify({ ...config, oauthAccount: next }, null, 2);
  const mode = (() => {
    try {
      return fs.statSync(CLAUDE_GLOBAL_CONFIG).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  const temp = `${CLAUDE_GLOBAL_CONFIG}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, CLAUDE_GLOBAL_CONFIG);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

async function apiGet(url, accessToken, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: compact({
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...extraHeaders,
    }),
  });
  const text = await res.text();
  const body = readJsonText(text) ?? text;
  return { status: res.status, ok: res.ok, body, headers: res.headers };
}

function claudeUsageRequest(record) {
  return apiGet(USAGE_URL, record.accessToken, { 'anthropic-beta': OAUTH_BETA });
}

function codexUsageRequest(record) {
  return apiGet(CODEX_USAGE_URL, record.accessToken, { 'ChatGPT-Account-Id': record.accountId });
}

function usageRequest(record) {
  return accountProvider(record) === 'codex' ? codexUsageRequest(record) : claudeUsageRequest(record);
}

function codexTokensFromResponse(body, previous = {}) {
  const idToken = body.id_token || previous.idToken;
  const lastRefresh = Date.now();
  return compact({
    provider: 'codex',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || previous.refreshToken,
    idToken,
    lastRefresh,
    expiresAt: jwtExpiry(body.access_token) ?? lastRefresh + (Number(body.expires_in) * 1000 || CODEX_TOKEN_LIFETIME_MS),
    ...codexIdentity({ id_token: idToken, account_id: previous.accountId }),
  });
}

/** OpenAI's refresh tokens rotate too: the reply carries the next one and retires this one. */
export async function refreshCodexToken(refreshToken, previous = {}) {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const text = await res.text();
  const body = readJsonText(text) ?? text;
  if (res.ok && body?.access_token) return codexTokensFromResponse(body, { ...previous, refreshToken });
  throw new Error(`token refresh failed (${res.status} @ ${new URL(CODEX_TOKEN_URL).host}): ${describeBody(body)}`);
}

export function buildCodexAuthorizeUrl({ redirectUri, challenge, state }) {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', CODEX_LOGIN_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('originator', CODEX_ORIGINATOR);
  return url.toString();
}

/** The Codex token endpoint takes the authorization-code grant as a form, not JSON. */
export async function exchangeCodexAuthorizationCode(code, codeVerifier, redirectUri) {
  if (!code) throw new Error('no authorization code to exchange');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const text = await res.text();
  const body = readJsonText(text) ?? text;
  if (res.ok && body?.access_token) return body;
  throw new Error(`code exchange failed (${res.status} @ ${new URL(CODEX_TOKEN_URL).host}): ${describeBody(body)}`);
}

export function tokensFromResponse(body, previousRefreshToken) {
  return compact({
    accessToken: body.access_token,
    refreshToken: body.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? Date.now() + Number(body.refresh_token_expires_in) * 1000
      : undefined,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ') : undefined,
  });
}

export async function refreshAccessToken(refreshToken) {
  let lastError;
  for (const url of TOKEN_URLS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID }),
    });
    const text = await res.text();
    const body = readJsonText(text) ?? text;
    if (res.ok && body?.access_token) return tokensFromResponse(body, refreshToken);
    lastError = new Error(`token refresh failed (${res.status} @ ${new URL(url).host}): ${describeBody(body)}`);
    if (res.status === 400 || res.status === 401) break;
  }
  throw lastError;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildAuthorizeUrl({ useConsole, redirectUri, challenge, state, scopes }) {
  const url = new URL(useConsole ? AUTHORIZE_URL_CONSOLE : AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

const BROWSER_URL_HOSTS = new Set([
  new URL(AUTHORIZE_URL).host,
  new URL(AUTHORIZE_URL_CONSOLE).host,
  new URL(CODEX_AUTHORIZE_URL).host,
]);

/** Only ever hand the browser an https URL on a host we build ourselves. */
export function isSafeBrowserUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !BROWSER_URL_HOSTS.has(parsed.host)) return false;
  // On Windows the URL is passed inside double quotes, where cmd.exe treats `&`,
  // `|`, `^` and friends literally — a percent-encoded OAuth URL legitimately
  // contains `&` and `%`. Only a quote, newline or NUL could break out of that
  // quoting, so those are what must never appear.
  return !/["\r\n\0]/.test(url);
}

export function openBrowser(url) {
  if (!isSafeBrowserUrl(url)) return false;
  try {
    // No `shell: true` anywhere: the authorize URL is full of `&`, which cmd.exe would
    // treat as a command separator. On Windows `start` is a cmd builtin, so invoke
    // cmd.exe directly and control the quoting ourselves.
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
          stdio: 'ignore',
          detached: true,
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Compare two secrets without leaking their length or contents through timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// The callback page is served to a browser, so lock it down: no scripts, no
// embedding, no caching of a URL that carries an authorization code, and no
// referrer that could carry that code to a third party.
const CALLBACK_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function waitForCallback(port, expectedState, callbackPath = CALLBACK_PATH) {
  let close = () => {};
  let bind = async () => port;
  const promise = new Promise((resolve, reject) => {
    const finishPage = (title, detail) =>
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:48px;background:#faf9f5"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></body>`;
    const settle = (fn, value) => {
      clearTimeout(timer);
      server.close();
      fn(value);
    };
    const server = http.createServer((req, res) => {
      // A stray long request must not become a memory sink on a port anything
      // local can reach.
      if (!req.url || req.url.length > 8192 || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(400, CALLBACK_HEADERS);
        res.end(finishPage('usage-bar', 'Unsupported request.'));
        return;
      }
      const requestUrl = new URL(req.url, `http://localhost:${port}`);
      const returnedState = requestUrl.searchParams.get('state');
      if (requestUrl.pathname !== callbackPath || !safeEqual(returnedState ?? '', expectedState)) {
        res.writeHead(404, CALLBACK_HEADERS);
        res.end(finishPage('usage-bar', 'This is not the login callback this session is waiting for.'));
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const authError = requestUrl.searchParams.get('error');
      const failure = authError ? `authorization failed: ${authError}` : !code ? 'no authorization code in callback' : null;
      res.writeHead(failure ? 400 : 200, CALLBACK_HEADERS);
      res.end(
        failure
          ? finishPage('usage-bar: login failed', failure)
          : finishPage('usage-bar: login complete', 'You can close this tab and go back to your editor.'),
      );
      if (failure) settle(reject, new Error(failure));
      else settle(resolve, code);
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 64;
    const timer = setTimeout(() => {
      settle(reject, new Error('timed out waiting for the browser callback (5 min)'));
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    server.on('error', (error) => settle(reject, error));
    bind = () =>
      new Promise((bound, failed) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          failed(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          bound(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
    close = () => settle(reject, Object.assign(new Error('login cancelled'), { code: 'ELOGINCANCELLED' }));
  });
  promise.catch(() => {});
  return { promise, close, bind: () => bind() };
}

function pkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(32));
  return { codeVerifier, challenge, state };
}

/**
 * The Codex sign-in. OpenAI accepts only two loopback redirect ports for this
 * client, so there is no "any free port" fallback and no paste-the-code flow: if
 * both are taken, the caller has to free one (usually a `codex login` left open).
 */
async function beginCodexLogin() {
  const { codeVerifier, challenge, state } = pkcePair();
  let callback = null;
  let port = null;
  for (const candidate of CODEX_CALLBACK_PORTS) {
    const attempt = waitForCallback(candidate, state, CODEX_CALLBACK_PATH);
    try {
      port = await attempt.bind();
      callback = attempt;
      break;
    } catch (error) {
      attempt.close();
      await attempt.promise.catch(() => {});
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  if (!callback) {
    throw Object.assign(
      new Error(`ports ${CODEX_CALLBACK_PORTS.join(' and ')} are both in use (a \`codex login\` in progress?) — OpenAI accepts only those two callback ports, so close whatever holds them and retry`),
      { code: 'EADDRINUSE' },
    );
  }
  const redirectUri = `http://localhost:${port}${CODEX_CALLBACK_PATH}`;
  return {
    provider: 'codex',
    authorizeUrl: buildCodexAuthorizeUrl({ redirectUri, challenge, state }),
    redirectUri,
    codeVerifier,
    state,
    port,
    waitForCode: () => callback.promise,
    cancel: callback.close,
  };
}

export async function beginLogin({ provider = 'claude', scopes = LOGIN_SCOPES_FULL, manual = false, useConsole = false } = {}) {
  if (accountProvider({ provider }) === 'codex') {
    if (manual) throw new Error('the Codex login has no paste-the-code flow — OpenAI only redirects to localhost');
    return beginCodexLogin();
  }
  const { codeVerifier, challenge, state } = pkcePair();

  if (manual) {
    return {
      provider: 'claude',
      authorizeUrl: buildAuthorizeUrl({ useConsole, redirectUri: MANUAL_REDIRECT_URI, challenge, state, scopes }),
      redirectUri: MANUAL_REDIRECT_URI,
      codeVerifier,
      state,
      port: null,
      waitForCode: null,
      cancel: () => {},
    };
  }

  // Bind before handing out an authorize URL. A leftover server from an abandoned
  // login owns the default port and would answer the browser with someone else's
  // state, so take any free port rather than fail or collide.
  let callback = waitForCallback(CALLBACK_PORT, state);
  let port;
  try {
    port = await callback.bind();
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    callback.close();
    await callback.promise.catch(() => {});
    callback = waitForCallback(0, state);
    port = await callback.bind();
  }

  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  return {
    provider: 'claude',
    authorizeUrl: buildAuthorizeUrl({ useConsole, redirectUri, challenge, state, scopes }),
    redirectUri,
    codeVerifier,
    state,
    port,
    waitForCode: () => callback.promise,
    cancel: callback.close,
  };
}

export async function exchangeAuthorizationCode(pastedCode, expectedState, codeVerifier, redirectUri) {
  const [code, embeddedState] = String(pastedCode).trim().split('#');
  if (!code) throw new Error('no authorization code to exchange');
  // The manual flow has the user paste `code#state` back in. Trusting the pasted
  // state would let someone hand over their own code and silently attach their
  // account instead — so the state must match the one this session generated.
  if (embeddedState !== undefined && !safeEqual(embeddedState, expectedState)) {
    throw new Error('the pasted code does not belong to this login attempt (state mismatch) — start the login again and paste the code from that browser window');
  }
  let lastError;
  for (const url of TOKEN_URLS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        state: expectedState,
        redirect_uri: redirectUri,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
    });
    const text = await res.text();
    const body = readJsonText(text) ?? text;
    if (res.ok && body?.access_token) return body;
    lastError = new Error(`code exchange failed (${res.status} @ ${new URL(url).host}): ${describeBody(body)}`);
    if (res.status === 400 || res.status === 401) break;
  }
  throw lastError;
}

export async function fetchProfile(accessToken) {
  const res = await apiGet(PROFILE_URL, accessToken);
  if (!res.ok) throw new Error(`profile ${res.status}: ${describeBody(res.body)}`);
  const account = res.body.account ?? res.body;
  const organization = res.body.organization ?? {};
  const email = account.email ?? account.emailAddress ?? account.email_address;
  if (!email) throw new Error('profile response did not include an email');
  return {
    email,
    profile: compact({
      accountUuid: account.uuid,
      emailAddress: email,
      displayName: account.display_name,
      fullName: account.full_name,
      organizationUuid: organization.uuid,
      organizationName: organization.name,
      organizationType: organization.organization_type,
      billingType: organization.billing_type,
      organizationRateLimitTier: organization.rate_limit_tier,
    }),
  };
}

export function isExpired(record, margin = REFRESH_MARGIN_MS) {
  return !record.expiresAt || record.expiresAt - Date.now() <= margin;
}

/**
 * Codex twin of the Claude path below: refresh, store, and hand the rotated pair
 * back to auth.json when Codex still holds the one we just spent — otherwise the
 * next `codex` run would redeem a retired token and lose its login.
 */
async function ensureFreshCodex(record, live, { force = false } = {}) {
  if (!force && !isExpired(record)) return record;
  if (!record.refreshToken) throw new Error('no refresh token stored; run `login --provider codex` or `add --provider codex` for this account');
  const previousRefreshToken = record.refreshToken;
  const fresh = await refreshCodexToken(previousRefreshToken, record);
  const next = { ...record, ...fresh, updatedAt: Date.now() };
  tokenSet(storeKey(record), next);
  if (live?.json?.tokens?.refresh_token === previousRefreshToken) {
    try {
      const written = writeCodexAuth(live, next);
      live.json = written.json;
    } catch (error) {
      warn(`refreshed ${record.email} but could not update Codex credentials: ${error.message}`);
    }
  }
  return next;
}

export async function ensureFresh(record, live, { force = false } = {}) {
  if (accountProvider(record) === 'codex') return ensureFreshCodex(record, live, { force });
  if (!force && !isExpired(record)) return record;
  if (!record.refreshToken) throw new Error('no refresh token stored; run `login` or `add` for this account');
  const previousRefreshToken = record.refreshToken;
  const fresh = await refreshAccessToken(previousRefreshToken);
  const next = { ...record, ...fresh, scopes: fresh.scopes ?? record.scopes, updatedAt: Date.now() };
  tokenSet(storeKey(record), next);
  if (live?.json?.claudeAiOauth?.refreshToken === previousRefreshToken) {
    try {
      const written = writeClaudeCode(live, compact({
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt,
      }));
      live.json = written.json;
    } catch (error) {
      warn(`refreshed ${record.email} but could not update Claude Code credentials: ${error.message}`);
    }
  }
  return next;
}

function adoptLive(record, live) {
  const oauth = live.json.claudeAiOauth;
  if (oauth.accessToken === record.accessToken) return record;
  if ((oauth.expiresAt ?? 0) <= (record.expiresAt ?? 0)) return record;
  const next = compact({
    ...record,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken ?? record.refreshToken,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt ?? record.refreshTokenExpiresAt,
    scopes: oauth.scopes ?? record.scopes,
    subscriptionType: oauth.subscriptionType ?? record.subscriptionType,
    rateLimitTier: oauth.rateLimitTier ?? record.rateLimitTier,
    updatedAt: Date.now(),
  });
  tokenSet(storeKey(record), next);
  return next;
}

function claudeRecords(records) {
  return records.filter((r) => accountProvider(r) === 'claude');
}

export function matchLiveEmail(live, records) {
  const oauth = live.json.claudeAiOauth;
  const byToken = claudeRecords(records).find((r) => r.refreshToken === oauth.refreshToken || r.accessToken === oauth.accessToken);
  if (byToken) return { email: byToken.email, verified: true };
  const hint = readClaudeGlobalConfig()?.oauthAccount?.emailAddress;
  return { email: hint ?? null, verified: false };
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

export async function resolveLiveEmail(live, records) {
  const match = matchLiveEmail(live, records);
  if (match.verified) return match;
  const oauth = live.json.claudeAiOauth;
  if (!isExpired(oauth, 0)) {
    // This rides on Claude Code's own token. A lookup that keeps failing (throttled,
    // offline) must not be repeated by every front end on every refresh — that is
    // exactly the knocking that keeps a throttle from clearing.
    const fingerprint = tokenFingerprint(oauth.accessToken);
    const recent = readCache()[PROFILE_KEY];
    if (recent?.fingerprint === fingerprint && Date.now() - (recent.failedAt ?? 0) < PROFILE_RETRY_SPACING_MS) {
      return match;
    }
    try {
      return { email: (await fetchProfile(oauth.accessToken)).email, verified: true };
    } catch (error) {
      await cacheUpdate(PROFILE_KEY, { fingerprint, failedAt: Date.now() }, { replace: true });
      warn(`could not verify the active Claude Code account: ${error.message}`);
    }
  }
  return match;
}

export function loadRecords(index = loadIndex()) {
  return index.accounts.map((entry) => {
    const provider = accountProvider(entry);
    const record = tokenGet(storeKey(entry));
    return record
      ? { ...record, provider, email: entry.email, label: entry.label }
      : { provider, email: entry.email, label: entry.label, missing: true };
  });
}

export async function syncFromLive(records) {
  const live = readClaudeCode();
  if (!live) return { live: null, liveEmail: null, liveVerified: false, records };
  const { email: liveEmail, verified } = await resolveLiveEmail(live, records);
  const synced = records.map((record) => {
    if (accountProvider(record) !== 'claude' || !verified || record.email !== liveEmail || record.missing) return record;
    try {
      const next = adoptLive(record, live);
      if (next !== record) infoHandler(`synced ${record.email} from Claude Code`);
      return next;
    } catch (error) {
      warn(`could not store Claude Code's token for ${record.email}: ${error.message}`);
      return record;
    }
  });
  return { live, liveEmail, liveVerified: verified, records: synced };
}

function adoptCodexLive(record, live) {
  const working = codexWorkingFromLive(live);
  if (working.accessToken === record.accessToken) return record;
  // Codex stamps last_refresh on every rotation, so newer there means newer, full stop.
  if ((working.lastRefresh ?? 0) <= (record.lastRefresh ?? 0)) return record;
  const next = compact({ ...record, ...working, updatedAt: Date.now() });
  tokenSet(storeKey(record), next);
  return next;
}

/**
 * The Codex side of syncFromLive. Identity comes straight out of auth.json's
 * id_token, so this is purely local and never costs a request.
 */
export function syncFromCodex(records, { adopt = true } = {}) {
  const live = readCodexAuth();
  if (!live) return { live: null, liveEmail: null, records };
  const liveEmail = codexIdentity(live.json.tokens).email ?? null;
  const synced = records.map((record) => {
    if (!adopt || accountProvider(record) !== 'codex' || record.missing || !liveEmail || record.email !== liveEmail) return record;
    try {
      const next = adoptCodexLive(record, live);
      if (next !== record) infoHandler(`synced ${record.email} from Codex`);
      return next;
    } catch (error) {
      warn(`could not store Codex's token for ${record.email}: ${error.message}`);
      return record;
    }
  });
  return { live, liveEmail, records: synced };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCache() {
  const cache = readJsonFile(CACHE_FILE, {});
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
}

function writeCache(cache) {
  try {
    writePrivateJson(CACHE_FILE, cache);
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Run `fn` with exclusive access to the cache file. Every front end on the machine
 * shares that file, and an unlocked read-modify-write from two processes at once
 * loses whichever update landed first — including a 429 cooldown, after which the
 * next poller knocks again and keeps the throttle alive. `fn` must stay synchronous
 * so nothing else in this process can interleave with it either.
 */
async function withCacheLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fd = fs.openSync(CACHE_LOCK_FILE, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(CACHE_LOCK_FILE).mtimeMs;
      } catch {
        /* released between our open and stat — go round again */
      }
      // Holders keep the lock for milliseconds; anything this old belongs to a process that died.
      if (age > LOCK_STALE_MS) {
        fs.rmSync(CACHE_LOCK_FILE, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw Object.assign(new Error('the usage cache is locked by another process'), { code: 'ELOCKED' });
      }
      await sleep(15 + Math.random() * 35);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(CACHE_LOCK_FILE, { force: true });
    }
  }
}

/**
 * Write one cache entry under the lock. By default `patch` is merged into the entry
 * (a null or undefined value removes that key); with `replace` it becomes the entry.
 */
async function cacheUpdate(key, patch, { replace = false } = {}) {
  try {
    await withCacheLock(() => {
      const cache = readCache();
      const entry = replace ? {} : { ...(cache[key] ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete entry[k];
        else entry[k] = v;
      }
      cache[key] = entry;
      writeCache(cache);
    });
  } catch (error) {
    warn(`could not update the usage cache: ${error.message}`);
  }
}

function lastAttemptAt(entry) {
  return Math.max(entry.attemptedAt ?? 0, entry.fetchedAt ?? 0);
}

function spacingFor(entry, now) {
  const recentlyLimited = entry.lastLimitedAt && now - entry.lastLimitedAt < LIMITED_MEMORY_MS;
  return recentlyLimited ? MIN_FETCH_SPACING_MS * 2 : MIN_FETCH_SPACING_MS;
}

function inCooldown(entry, now) {
  return (entry.limitedUntil ?? 0) > now;
}

/**
 * Decide, atomically across processes, whether the caller may send a usage request
 * for `email` right now. When it may, the attempt is recorded before the request
 * goes out, so even a crash mid-request counts against the spacing.
 */
function claimFetchSlot(email, now = Date.now()) {
  const cache = readCache();
  const entry = cache[email] ?? {};
  if (inCooldown(entry, now)) return { kind: 'cooldown', entry };
  const sinceLast = now - lastAttemptAt(entry);
  if (sinceLast < spacingFor(entry, now) - SPACING_TOLERANCE_MS) {
    const inflight = !entry.usage && !entry.lastError && Boolean(entry.attemptedAt) && sinceLast < INFLIGHT_WAIT_MS;
    return { kind: inflight ? 'inflight' : 'spacing', entry };
  }
  const sinceAny = now - (cache[MACHINE_KEY]?.attemptedAt ?? 0);
  if (sinceAny < ACCOUNT_STAGGER_MS) return { kind: 'wait', ms: ACCOUNT_STAGGER_MS - sinceAny, entry };
  cache[email] = { ...entry, attemptedAt: now };
  cache[MACHINE_KEY] = { attemptedAt: now };
  writeCache(cache);
  return { kind: 'go', entry, claimedAt: now };
}

function fromCacheResult(record, entry, stale) {
  return compact({ record, usage: entry.usage, fetchedAt: entry.fetchedAt, fromCache: true, stale });
}

function rateLimitedMessage(entry) {
  return `rate limited — next try in ${formatRelative((entry.limitedUntil ?? 0) - Date.now())}`;
}

const THROTTLE_NOTE = 'request throttling by the usage endpoint, not your subscription quota';

/**
 * Usage for one account. Goes to the network only when the machine-wide timing
 * policy allows it (the constants at the top of this file); otherwise answers from
 * the cache, or with the error the last attempt left behind, without sending anything.
 * `live` is the matching CLI's own login (Claude Code's, or Codex's auth.json), so a
 * refresh made here can be handed back to it.
 */
export async function fetchUsage(record, live) {
  // Cache entries are keyed like the token store: a bare email for Claude, so caches
  // written by earlier versions carry over; namespaced for Codex.
  const email = storeKey(record);
  let gate;
  for (;;) {
    try {
      gate = await withCacheLock(() => claimFetchSlot(email));
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      // Cannot coordinate, so do the safe thing: answer from the cache, send nothing.
      gate = { kind: 'spacing', entry: readCache()[email] ?? {} };
    }
    if (gate.kind === 'wait') {
      await sleep(gate.ms);
      continue;
    }
    if (gate.kind === 'inflight') {
      await sleep(500);
      continue;
    }
    break;
  }
  const { entry, claimedAt } = gate;
  if (gate.kind === 'cooldown') {
    if (entry.usage) return fromCacheResult(record, entry, rateLimitedMessage(entry));
    throw new Error(`${rateLimitedMessage(entry)} (${THROTTLE_NOTE})`);
  }
  if (gate.kind === 'spacing') {
    if (entry.usage) {
      const age = entry.fetchedAt ? ` — showing values from ${formatRelative(Date.now() - entry.fetchedAt)} ago` : '';
      return fromCacheResult(record, entry, entry.lastError ? `${entry.lastError}${age}` : undefined);
    }
    throw new Error(entry.lastError ?? 'no usage data yet — another process is fetching it, try again in a moment');
  }

  let current;
  let res;
  try {
    current = await ensureFresh(record, live);
    res = await usageRequest(current);
    if (res.status === 401) {
      current = await ensureFresh(current, live, { force: true });
      res = await usageRequest(current);
    }
  } catch (error) {
    await cacheUpdate(email, { lastError: redact(error.message) });
    throw error;
  }
  if (res.status === 429) {
    const strikes = (entry.strikes ?? 0) + 1;
    const retryAfterMs = (Number(res.headers?.get?.('retry-after')) || 0) * 1000;
    const cooldown = Math.max(retryAfterMs, Math.min(RATE_LIMIT_COOLDOWN_MAX_MS, RATE_LIMIT_COOLDOWN_MS * 2 ** (strikes - 1)));
    const limitedUntil = Date.now() + cooldown;
    await cacheUpdate(email, {
      limitedUntil,
      strikes,
      lastLimitedAt: Date.now(),
      lastError: 'rate limited',
    });
    const next = { limitedUntil };
    if (entry.usage) return fromCacheResult(current, entry, rateLimitedMessage(next));
    throw new Error(`${rateLimitedMessage(next)} (${THROTTLE_NOTE})`);
  }
  if (res.status >= 500) {
    const message = `${PROVIDER_VENDORS[accountProvider(record)]} returned ${res.status}`;
    await cacheUpdate(email, { lastError: message });
    if (entry.usage) return fromCacheResult(current, entry, `${message} — showing the last known values`);
    throw new Error(`${message} — temporary, the next refresh should recover`);
  }
  if (!res.ok) {
    const message = `usage ${res.status}: ${describeBody(res.body)}`;
    await cacheUpdate(email, { lastError: message });
    throw new Error(message);
  }
  const fetchedAt = Date.now();
  // A full replace: this also drops strikes, the cooldown and errors from earlier
  // rounds; only the memory of a recent 429 carries over.
  await cacheUpdate(
    email,
    {
      usage: res.body,
      fetchedAt,
      attemptedAt: claimedAt,
      lastLimitedAt: entry.lastLimitedAt,
    },
    { replace: true },
  );
  return { record: current, usage: res.body, fetchedAt, fromCache: false };
}

export function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

function topLevelWindows(usage) {
  return Object.entries(usage)
    .filter(([key, value]) => key !== 'extra_usage' && key !== 'spend' && value && typeof value === 'object' && 'utilization' in value)
    .filter(([key, value]) => WINDOW_LABELS[key] || (pct(value.utilization) ?? 0) > 0 || value.resets_at)
    .sort(([a], [b]) => {
      const ia = WINDOW_ORDER.indexOf(a);
      const ib = WINDOW_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    })
    .map(([key, value]) => ({
      key,
      group: key === 'five_hour' ? 'session' : 'weekly',
      label: WINDOW_LABELS[key] ?? key,
      percent: pct(value.utilization),
      resetsAt: value.resets_at ?? null,
      severity: value.locked_reason ? 'locked' : null,
      active: false,
    }));
}

function scopeName(scope) {
  return scope?.model?.display_name ?? scope?.model?.id ?? scope?.surface ?? null;
}

function limitLabel(limit) {
  const scope = scopeName(limit.scope);
  if (limit.kind === 'session') return '5h session';
  if (limit.kind === 'weekly_all') return '7d all';
  if (limit.group === 'weekly') return `7d ${scope ?? limit.kind.replace(/^weekly_/, '')}`;
  return scope ? `${limit.kind} ${scope}` : limit.kind;
}

/** A Codex `/wham/usage` body: `plan_type` plus `rate_limit.{primary,secondary}_window`. */
export function isCodexUsage(usage) {
  return Boolean(usage) && typeof usage === 'object' && !Array.isArray(usage.limits) && ('rate_limit' in usage || 'plan_type' in usage);
}

function severityTag(percent) {
  const severity = severityFor(percent);
  return severity === 'warning' || severity === 'critical' ? severity : null;
}

/**
 * Codex windows are described by their length: 18 000 s is the 5-hour session
 * limit, 604 800 s the weekly one. Only the main `rate_limit` — the one the normal
 * models draw on — is reported; the per-model side limits in
 * `additional_rate_limits` (e.g. a Spark model) are deliberately left out.
 */
function codexWindows(usage) {
  const windows = [];
  const add = (snapshot, keyBase, status) => {
    if (!snapshot || typeof snapshot !== 'object') return;
    const seconds = Number(snapshot.limit_window_seconds) || 0;
    const hours = Math.round(seconds / 3600);
    const session = seconds > 0 && seconds <= 24 * 3600;
    const span = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours || '?'}h`;
    const percent = pct(snapshot.used_percent);
    let resetsAt = null;
    if (Number(snapshot.reset_at) > 0) resetsAt = new Date(Number(snapshot.reset_at) * 1000).toISOString();
    else if (Number.isFinite(Number(snapshot.reset_after_seconds))) resetsAt = new Date(Date.now() + Number(snapshot.reset_after_seconds) * 1000).toISOString();
    const locked = status?.allowed === false && (percent ?? 0) >= 100;
    windows.push({
      key: keyBase,
      group: session ? 'session' : 'weekly',
      label: session ? `${span} session` : `${span} all`,
      percent,
      resetsAt,
      severity: locked ? 'locked' : severityTag(percent),
      active: false,
    });
  };
  const main = usage.rate_limit;
  if (main && typeof main === 'object') {
    add(main.primary_window, 'primary', main);
    add(main.secondary_window, 'secondary', main);
  }
  return windows;
}

export function normalizeWindows(usage) {
  if (isCodexUsage(usage)) return codexWindows(usage);
  if (Array.isArray(usage?.limits) && usage.limits.length > 0) {
    return usage.limits.map((limit) => ({
      key: `${limit.kind}${limit.scope ? `:${scopeName(limit.scope) ?? 'scoped'}` : ''}`,
      group: limit.group ?? (limit.kind === 'session' ? 'session' : 'weekly'),
      label: limitLabel(limit),
      percent: pct(limit.percent),
      resetsAt: limit.resets_at ?? null,
      severity: limit.severity && limit.severity !== 'normal' ? limit.severity : null,
      active: Boolean(limit.is_active),
    }));
  }
  return usage ? topLevelWindows(usage) : [];
}

export function headroom(usage) {
  const windows = normalizeWindows(usage);
  const session = windows.find((w) => w.group === 'session')?.percent ?? 0;
  const weekly = Math.max(0, ...windows.filter((w) => w.group === 'weekly').map((w) => w.percent ?? 0));
  return { session, weekly };
}

export const LOGIN_WARN_MS = 5 * 86400000;

export const SEVERITY_THRESHOLDS = { warning: 60, critical: 80 };

/** A login minted with only user:profile can read usage but cannot run inference. */
export function isReadOnly(record) {
  return Array.isArray(record?.scopes) && !record.scopes.includes('user:inference');
}

export function severityFor(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (percent >= SEVERITY_THRESHOLDS.warning) return 'warning';
  return 'ok';
}

export function loginHealth(result) {
  const record = result.record ?? result;
  const left = record.refreshTokenExpiresAt ? record.refreshTokenExpiresAt - Date.now() : null;
  if (record.missing) {
    return { state: 'missing', message: 'no stored token — sign in again', action: 'login' };
  }
  if (result.needsLogin) {
    return { state: 'expired', message: 'login expired or revoked — sign in again', action: 'login' };
  }
  if (left !== null && left <= 0) {
    return { state: 'expired', message: 'login expired — sign in again', action: 'login' };
  }
  if (left !== null && left < LOGIN_WARN_MS) {
    return { state: 'expiring', message: `login expires in ${formatRelative(left)}`, action: 'login', left };
  }
  if (left !== null) {
    return { state: 'ok', message: `login valid for ${formatRelative(left)}`, left };
  }
  if (accountProvider(record) === 'codex') {
    // OpenAI publishes no lifetime and the credential carries none; what can be said
    // is that it works (a dead one surfaces as `needsLogin` above) and when it last rotated.
    const rotated = record.lastRefresh ? ` · token refreshed ${formatRelative(Date.now() - record.lastRefresh)} ago` : '';
    return { state: 'ok', message: `login active${rotated}` };
  }
  return { state: 'unknown', message: 'login lifetime unknown — sign in to track it' };
}

export function tierLabel(record) {
  if (accountProvider(record) === 'codex') {
    const plan = record.planType ?? record.profile?.planType ?? '';
    const name = CODEX_PLAN_NAMES[String(plan).toLowerCase()] ?? (plan ? `${String(plan)[0].toUpperCase()}${String(plan).slice(1)}` : '');
    return name ? `ChatGPT ${name}` : 'ChatGPT';
  }
  const tier = record.rateLimitTier || record.profile?.organizationRateLimitTier || '';
  const match = tier.match(/(pro|max)_?(\d+x)?/i);
  if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}${match[2] ? ` ${match[2]}` : ''}`;
  return record.subscriptionType ?? '';
}

export function formatRelative(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

export function formatLocal(date) {
  const rounded = new Date(Math.round(date.getTime() / 60000) * 60000);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(rounded);
}

async function identify(provider, working) {
  if (provider === 'codex') {
    const identity = codexIdentity(working);
    if (!identity.email) throw new Error('the Codex login did not include an email address in its id_token');
    return { email: identity.email, profile: compact({ emailAddress: identity.email, ...identity }) };
  }
  return fetchProfile(working.accessToken);
}

export async function persistAccount(working, { label: requestedLabel, mergeClaudeJson = false, source, provider: requestedProvider } = {}) {
  const provider = accountProvider({ provider: working.provider ?? requestedProvider });
  const { email, profile } = await identify(provider, working);
  const mergedProfile = { ...profile };
  if (provider === 'claude' && mergeClaudeJson) {
    const cached = readClaudeGlobalConfig()?.oauthAccount;
    if (cached?.emailAddress === email) {
      for (const key of PROFILE_FIELDS) if (cached[key] !== undefined && cached[key] !== null) mergedProfile[key] = cached[key];
    }
  }
  const index = loadIndex();
  const existing = index.accounts.find((a) => a.email === email && accountProvider(a) === provider);
  const label = requestedLabel || existing?.label || email.split('@')[0];
  const key = storeKey({ provider, email });
  const previous = tokenGet(key);
  const record = compact({
    ...previous,
    ...working,
    provider,
    email,
    label,
    profile: mergedProfile,
    source: source ?? previous?.source,
    capturedAt: previous?.capturedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  tokenSet(key, record);
  if (existing) existing.label = label;
  else index.accounts.push({ email, label, provider, addedAt: new Date().toISOString() });
  saveIndex(index);
  return { record, label, email, provider, isNew: !existing };
}

export async function completeLogin({ provider = 'claude', pastedCode, state, codeVerifier, redirectUri, label }) {
  if (accountProvider({ provider }) === 'codex') {
    const body = await exchangeCodexAuthorizationCode(String(pastedCode ?? '').trim(), codeVerifier, redirectUri);
    return persistAccount(codexTokensFromResponse(body), { label, source: 'oauth-login' });
  }
  const body = await exchangeAuthorizationCode(pastedCode, state, codeVerifier, redirectUri);
  return persistAccount(tokensFromResponse(body, undefined), { label, source: 'oauth-login' });
}

/** Copy the login the Codex CLI holds, refreshing first if its access token has lapsed. */
export async function captureFromCodex({ label } = {}) {
  const live = readCodexAuth();
  if (!live) throw new Error(`no Codex login found (${CODEX_AUTH_FILE})`);
  if (live.json.auth_mode && live.json.auth_mode !== 'chatgpt') {
    throw new Error(`Codex is signed in with ${live.json.auth_mode}, not a ChatGPT login — only ChatGPT logins carry usage limits`);
  }
  let working = codexWorkingFromLive(live);
  let rotated = false;
  if (isExpired(working)) {
    working = { ...working, ...(await refreshCodexToken(working.refreshToken, working)) };
    rotated = true;
  }
  const saved = await persistAccount(working, { label, source: 'codex-cli' });
  if (rotated) {
    try {
      writeCodexAuth(live, working);
    } catch (error) {
      warn(`captured ${saved.email} but could not write the rotated token back to Codex: ${error.message}`);
    }
  }
  return saved;
}

export async function captureFromClaudeCode({ label } = {}) {
  const live = readClaudeCode();
  if (!live) throw new Error('no Claude Code login found');
  const oauth = live.json.claudeAiOauth;
  let working = compact({
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  });
  let rotated = false;
  if (isExpired(working)) {
    const fresh = await refreshAccessToken(working.refreshToken);
    working = { ...working, ...fresh, scopes: fresh.scopes ?? working.scopes };
    rotated = true;
  }
  const saved = await persistAccount(working, { label, mergeClaudeJson: true, source: 'claude-code' });
  if (rotated) {
    try {
      writeClaudeCode(live, compact({
        accessToken: working.accessToken,
        refreshToken: working.refreshToken,
        expiresAt: working.expiresAt,
        refreshTokenExpiresAt: working.refreshTokenExpiresAt,
      }));
    } catch (error) {
      warn(`captured ${saved.email} but could not write the rotated token back to Claude Code: ${error.message}`);
    }
  }
  return saved;
}

export function sortResults(results, mode) {
  if (!mode || mode === 'added') return results;
  const key = mode === '7d' ? 'weekly' : 'session';
  return [...results].sort((a, b) => {
    const pa = a.error ? 999 : headroom(a.usage)[key];
    const pb = b.error ? 999 : headroom(b.usage)[key];
    return pa - pb;
  });
}

/**
 * Every tracked account with its usage. `live` names the account each CLI is signed
 * in as right now (`liveEmail` is the Claude one, kept for older front ends), and
 * every result carries `active` for its own provider.
 */
export async function collect({ sync = true, sort, providers } = {}) {
  const index = loadIndex();
  const empty = { results: [], liveEmail: null, live: { claude: null, codex: null }, empty: true };
  if (index.accounts.length === 0) return empty;
  let records = loadRecords(index);
  // A provider filter is applied before anything is fetched, so a view of one
  // provider never spends the other's request budget.
  if (Array.isArray(providers) && providers.length > 0) records = records.filter((r) => providers.includes(accountProvider(r)));
  let live = null;
  let liveEmail = null;
  if (sync) {
    ({ live, liveEmail, records } = await syncFromLive(records));
  } else {
    live = readClaudeCode();
    liveEmail = live ? matchLiveEmail(live, records).email : null;
  }
  liveEmail = liveEmail ?? null;
  const codex = syncFromCodex(records, { adopt: sync });
  records = codex.records;
  const liveByProvider = { claude: liveEmail, codex: codex.liveEmail };
  const liveFor = { claude: live, codex: codex.live };
  // One account at a time: the requests that do go out are spaced by
  // ACCOUNT_STAGGER_MS, and cached accounts answer instantly anyway.
  const results = [];
  for (const record of records) {
    const provider = accountProvider(record);
    const active = Boolean(liveByProvider[provider]) && record.email === liveByProvider[provider];
    if (record.missing) {
      results.push({ record, active, error: 'token not found in store — run `login` or `add` for this account' });
      continue;
    }
    try {
      const { record: fresh, usage, fetchedAt, stale } = await fetchUsage(record, liveFor[provider]);
      results.push({ record: fresh, active, usage, fetchedAt, stale });
    } catch (error) {
      const dead = /invalid_grant|no refresh token|refresh token/i.test(error.message);
      results.push({ record, active, error: error.message, needsLogin: dead });
    }
  }
  return { results: sortResults(results, sort), liveEmail, live: liveByProvider, empty: false };
}

/**
 * Resolve `<email|label>` to one index entry. A `claude:` / `codex:` prefix (or the
 * `provider` option) narrows the search; without one, a name that exists for both
 * providers is an error rather than a guess.
 */
export function findAccount(target, { provider } = {}) {
  let wanted = provider ? accountProvider({ provider }) : null;
  let name = String(target ?? '');
  const prefixed = /^(claude|codex):(.+)$/i.exec(name);
  if (prefixed) {
    wanted = prefixed[1].toLowerCase();
    name = prefixed[2];
  }
  const index = loadIndex();
  const pool = index.accounts.filter((a) => !wanted || accountProvider(a) === wanted);
  const describe = (a) => `${accountProvider(a)}:${a.email}`;
  const pick = (matches, byLabel) => {
    if (matches.length > 1) {
      const providers = new Set(matches.map(accountProvider));
      const hint = providers.size > 1 ? `say which with codex:${name} or claude:${name}` : 'use the email address';
      throw new Error(`"${name}" matches ${matches.length} accounts (${matches.map(describe).join(', ')}) — ${byLabel && providers.size > 1 ? `${hint}, or use the email address` : hint}`);
    }
    return matches.length === 1 ? { index, entry: matches[0], provider: accountProvider(matches[0]) } : null;
  };
  return pick(pool.filter((a) => a.email === name), false) ?? pick(pool.filter((a) => a.label === name), true);
}

export function removeAccount(target, options) {
  const found = findAccount(target, options);
  if (!found) throw new Error(`no tracked account matches "${target}"`);
  tokenDelete(storeKey(found.entry));
  found.index.accounts = found.index.accounts.filter((a) => a !== found.entry);
  saveIndex(found.index);
  return { ...found.entry, provider: found.provider };
}

/**
 * What each CLI is signed in as right now. With `verify` an unrecognised Claude Code
 * token is looked up over the network (subject to PROFILE_RETRY_SPACING_MS); without
 * it only local evidence is used. Codex identity is always local.
 */
export async function describeLive(records = loadRecords(), { verify = true } = {}) {
  const claude = readClaudeCode();
  const codex = readCodexAuth();
  return {
    claude: claude ? (verify ? await resolveLiveEmail(claude, records) : matchLiveEmail(claude, records)) : null,
    codex: codex ? { email: codexIdentity(codex.json.tokens).email ?? null, verified: true } : null,
  };
}

async function switchCodexAccount({ entry, index }) {
  const { live, liveEmail, records } = syncFromCodex(loadRecords(index));
  let record = records.find((r) => accountProvider(r) === 'codex' && r.email === entry.email);
  if (!record || record.missing) throw new Error(`token for ${entry.email} not found — run \`login --provider codex\` or \`add --provider codex\` for it`);
  if (live && liveEmail === entry.email && live.json.tokens.refresh_token === record.refreshToken) {
    return { entry, provider: 'codex', alreadyActive: true, untrackedReplaced: null };
  }
  const untrackedReplaced =
    live && !records.some((r) => accountProvider(r) === 'codex' && r.email === liveEmail && !r.missing) ? (liveEmail ?? 'an unidentified account') : null;
  record = await ensureFresh(record, null, { force: isExpired(record) });
  writeCodexAuth(live, record);
  return { entry, provider: 'codex', alreadyActive: false, untrackedReplaced, updatedGlobal: true };
}

export async function switchAccount(target, options) {
  const found = findAccount(target, options);
  if (!found) throw new Error(`no tracked account matches "${target}"`);
  if (found.provider === 'codex') return switchCodexAccount(found);
  const { entry, index } = found;
  const { live, liveEmail, liveVerified, records } = await syncFromLive(loadRecords(index));
  if (liveVerified && liveEmail === entry.email) return { entry, provider: 'claude', alreadyActive: true, untrackedReplaced: null };
  const untrackedReplaced =
    live && !(liveVerified && claudeRecords(records).some((r) => r.email === liveEmail && !r.missing)) ? (liveEmail ?? 'an unidentified account') : null;
  let record = claudeRecords(records).find((r) => r.email === entry.email);
  if (!record || record.missing) throw new Error(`token for ${entry.email} not found — run \`login\` or \`add\` for it`);
  if (isReadOnly(record)) {
    throw new Error(`${entry.email} was added read-only (${record.scopes.join(' ')}) and cannot run Claude Code — re-add it with a full-access login to switch to it`);
  }
  record = await ensureFresh(record, null, { force: isExpired(record) });
  writeClaudeCode(
    live,
    compact({
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      expiresAt: record.expiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
      scopes: record.scopes,
      subscriptionType: record.subscriptionType,
      rateLimitTier: record.rateLimitTier,
    }),
    { replace: true },
  );
  const updatedGlobal = updateClaudeGlobalAccount({ ...(record.profile ?? {}), emailAddress: record.email });
  return { entry, provider: 'claude', alreadyActive: false, untrackedReplaced, updatedGlobal };
}
