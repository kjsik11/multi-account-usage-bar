#!/usr/bin/env node
import readline from 'node:readline/promises';
import * as core from './src/core.mjs';

const BAR_WIDTH = 20;

const opts = parseArgs(process.argv.slice(2));
const useColor = !opts.flags['no-color'] && process.stdout.isTTY && !process.env.NO_COLOR;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Split on the first `=` only, so `--label=a=b` keeps its value whole.
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : a.slice(eq + 1);
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (['label', 'interval', 'sort', 'provider'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a === '-h') flags.help = true;
    else if (a === '-v' || a === '-V') flags.version = true;
    else positional.push(a);
  }
  // `--codex` / `--claude` are shorthands for `--provider`.
  if (flags.codex && !flags.provider) flags.provider = 'codex';
  if (flags.claude && !flags.provider) flags.provider = 'claude';
  if (flags.provider !== undefined && !core.PROVIDERS.includes(String(flags.provider).toLowerCase())) {
    console.error(`error: unknown provider "${flags.provider}" — use ${core.PROVIDERS.join(' or ')}`);
    process.exit(1);
  }
  if (flags.provider) flags.provider = String(flags.provider).toLowerCase();
  return { command: positional[0] || 'status', args: positional.slice(1), flags };
}

/** The provider a command acts on: `--provider`, else Claude — the pre-1.2 behaviour. */
const provider = () => opts.flags.provider ?? 'claude';
const providerName = () => core.PROVIDER_NAMES[provider()];
const clientName = () => core.PROVIDER_CLIENTS[provider()];
/** How to spell a provider on the command line, for the hints in error messages. */
const providerFlag = (p) => (p === 'codex' ? ' --provider codex' : '');

function paint(code, text) {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const red = (t) => paint('31', t);
const cyan = (t) => paint('36', t);

function fail(message) {
  console.error(red(`error: ${core.redact(message)}`));
  process.exit(1);
}

core.setLogger({
  onWarn: (message) => console.error(yellow(`warn: ${core.redact(message)}`)),
  onInfo: (message) => {
    if (!opts.flags.json) console.error(dim(message));
  },
});

function colorFor(p) {
  const severity = core.severityFor(p);
  if (severity === 'critical') return red;
  if (severity === 'warning') return yellow;
  if (severity === 'ok') return green;
  return dim;
}

function bar(p) {
  if (p === null) return dim('─'.repeat(BAR_WIDTH));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return colorFor(p)('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
}

// Each provider gets a glyph so the two are told apart at a glance even without colour:
// Claude's spark, and a hexagon for Codex.
const PROVIDER_GLYPHS = { claude: '✳', codex: '⬢' };
const providerTint = (p) => (p === 'codex' ? cyan : yellow);
const providerTag = (p) => providerTint(p)(`${PROVIDER_GLYPHS[p]} ${core.PROVIDER_NAMES[p]}`);
/**
 * padEnd by displayed width: colour codes count for nothing, wide characters (a
 * Korean label, an emoji) for two — so columns line up whatever the label is made of.
 */
const padVisible = (text, width) => text + ' '.repeat(Math.max(0, width - core.displayWidth(text.replace(/\x1b\[[0-9;]*m/g, ''))));

function renderAccount(result, labelWidth, { tagged = false } = {}) {
  const { record, usage, error, active } = result;
  const p = core.accountProvider(record);
  const lines = [];
  const marker = active ? green('●') : dim('○');
  const tag = tagged ? `${providerTag(p)} ` : '';
  const title = `${marker} ${tag}${bold(padVisible(record.label, labelWidth))} ${dim(record.email)}`;
  const health = core.loginHealth(result);
  const loginNote =
    health.state === 'expired' || health.state === 'missing'
      ? red(`${health.message} → usage-bar login${providerFlag(p)} --label ${record.label}`)
      : health.state === 'expiring'
        ? yellow(health.message)
        : dim(health.message);
  const meta = [core.tierLabel(record), active ? green(`active in ${core.PROVIDER_CLIENTS[p]}`) : '', loginNote].filter(Boolean).join(dim(' · '));
  lines.push(`${title}${meta ? `  ${meta}` : ''}`);
  if (error) {
    lines.push(`  ${red('✖')} ${error}`);
    return lines;
  }
  if (result.stale) lines.push(`  ${yellow('!')} ${dim(result.stale)}`);
  const now = Date.now();
  const windows = core.normalizeWindows(usage);
  const windowLabelWidth = Math.max(10, ...windows.map((w) => w.label.length));
  for (const window of windows) {
    const p = window.percent;
    const label = window.label.padEnd(windowLabelWidth);
    const pctText = p === null ? dim('  n/a') : colorFor(p)(`${String(Math.round(p)).padStart(3)}%`);
    const parts = [];
    if (window.resetsAt) {
      const at = new Date(window.resetsAt);
      parts.push(dim(`resets in ${core.formatRelative(at.getTime() - now)}  (${core.formatLocal(at)})`));
    }
    if (window.severity) parts.push((window.severity === 'locked' ? red : yellow)(`[${window.severity}]`));
    lines.push(`  ${label} ${bar(p)}  ${pctText}   ${parts.join('  ')}`);
  }
  const extra = usage?.extra_usage;
  if (extra && extra.is_enabled) {
    const used = extra.used_credits ?? '?';
    const limit = extra.monthly_limit ?? '∞';
    lines.push(`  ${'extra usage'.padEnd(windowLabelWidth)} ${dim(`$${used} / $${limit}`)}${extra.utilization != null ? dim(`  (${Math.round(extra.utilization)}%)`) : ''}`);
  }
  const credits = usage?.credits;
  if (credits && typeof credits === 'object' && (credits.has_credits || credits.unlimited)) {
    const balance = credits.unlimited ? 'unlimited' : credits.balance != null ? `$${credits.balance}` : 'available';
    lines.push(`  ${'credits'.padEnd(windowLabelWidth)} ${dim(balance)}`);
  }
  return lines;
}

function summarize(results, { named = false } = {}) {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return [];
  const p = core.accountProvider(ok[0].record);
  const who = named ? `${core.PROVIDER_NAMES[p]} ` : '';
  const best = [...ok].sort((a, b) => {
    const sa = core.headroom(a.usage);
    const sb = core.headroom(b.usage);
    return Math.max(sa.session, sa.weekly) - Math.max(sb.session, sb.weekly) || sa.session - sb.session;
  })[0];
  const { session: b5, weekly: b7 } = core.headroom(best.usage);
  const lines = [`${cyan('→')} ${who}most headroom now: ${bold(best.record.label)} ${dim(`(5h ${Math.round(b5)}% · 7d ${Math.round(b7)}%)`)}`];
  const nextReset = ok
    .map((r) => {
      const session = core.normalizeWindows(r.usage).find((w) => w.group === 'session');
      return { r, at: session?.resetsAt ? new Date(session.resetsAt).getTime() : null, p: session?.percent ?? 0 };
    })
    .filter((x) => x.at && x.p > 0)
    .sort((a, b) => a.at - b.at)[0];
  if (nextReset) {
    lines.push(`${cyan('→')} ${who}next 5h reset: ${bold(nextReset.r.record.label)} ${dim(`in ${core.formatRelative(nextReset.at - Date.now())}`)}`);
  }
  return lines;
}

/** Results grouped per provider, Claude first, in the order they were tracked. */
function byProvider(results) {
  return core.PROVIDERS.map((p) => [p, results.filter((r) => core.accountProvider(r.record) === p)]).filter(([, group]) => group.length > 0);
}

function render(results) {
  const labelWidth = Math.max(...results.map((r) => core.displayWidth(r.record.label)), 4);
  const groups = byProvider(results);
  const several = groups.length > 1;
  const heading = groups.map(([p]) => core.PROVIDER_NAMES[p]).join(' · ');
  const out = [
    bold(`${heading} usage`) + dim(`  ${core.formatLocal(new Date())}  (${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
    '',
  ];
  for (const [p, group] of groups) {
    // With both providers on screen each block is headed by its name; with one, the
    // title already says which and every account line carries the glyph instead.
    if (several) out.push(bold(providerTag(p)), '');
    for (const result of group) out.push(...renderAccount(result, labelWidth, { tagged: !several }), '');
    out.push(...summarize(group, { named: several }));
    if (several) out.push('');
  }
  if (several) out.pop();
  return out.join('\n');
}

function toJson(results) {
  return results.map((result) => {
    const { record, usage, error } = result;
    return {
      provider: core.accountProvider(record),
      email: record.email,
      label: record.label,
      active: Boolean(result.active),
      tier: core.tierLabel(record) || null,
      subscriptionType: record.subscriptionType ?? null,
      rateLimitTier: record.rateLimitTier ?? record.profile?.organizationRateLimitTier ?? null,
      planType: record.planType ?? null,
      tokenExpiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      loginExpiresAt: record.refreshTokenExpiresAt ? new Date(record.refreshTokenExpiresAt).toISOString() : null,
      login: core.loginHealth(result),
      readOnly: core.isReadOnly(record),
      canSwitch: !core.isReadOnly(record) && !record.missing,
      windows: core.normalizeWindows(usage).map((w) => ({
        key: w.key,
        label: w.label,
        group: w.group,
        percent: w.percent,
        resetsAt: w.resetsAt,
        severity: w.severity,
      })),
      usage: usage ?? null,
      stale: result.stale ?? null,
      fetchedAt: result.fetchedAt ? new Date(result.fetchedAt).toISOString() : null,
      error: error ?? null,
    };
  });
}

async function gather() {
  // `--provider` on status narrows the view to that provider's accounts.
  const wanted = opts.flags.provider;
  const { results, empty } = await core.collect({
    sync: !opts.flags['no-sync'],
    sort: opts.flags.sort,
    providers: wanted ? [wanted] : undefined,
  });
  // Nothing tracked is an empty answer for a script (`[]`), a hint for a person.
  if (opts.flags.json) return { results };
  if (empty) fail('no accounts tracked yet. Run `usage-bar login` (or `usage-bar login --provider codex`) to add one.');
  if (results.length === 0) fail(`no ${providerName()} accounts tracked yet. Run \`usage-bar login${providerFlag(wanted)}\` to add one.`);
  return { results };
}

async function cmdStatus() {
  const { results } = await gather();
  if (opts.flags.json) {
    console.log(JSON.stringify(toJson(results), null, 2));
    return;
  }
  console.log(render(results));
}

/** Redraw in place: home the cursor and clear each line's tail, instead of wiping the screen (which flickers). */
function redraw(text) {
  process.stdout.write(`\x1b[H${text.split('\n').map((line) => `${line}\x1b[K`).join('\n')}\n\x1b[J`);
}

async function cmdWatch() {
  const interval = Math.max(15, Number(opts.flags.interval) || 60) * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let body;
    try {
      const { results } = await gather();
      body = render(results);
    } catch (error) {
      body = red(`error: ${core.redact(error.message)}`);
    } finally {
      running = false;
    }
    redraw(`${body}\n\n${dim(`redrawing every ${interval / 1000}s · requests go out at most every ${core.MIN_FETCH_SPACING_MS / 60000} min per account · ctrl+c to quit`)}`);
  };
  // One full clear at the start; every tick after that paints over the previous frame.
  process.stdout.write('\x1b[2J\x1b[H');
  await tick();
  const timer = setInterval(tick, interval);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\n');
    process.exit(0);
  });
}

function reportSaved({ record, label, email, isNew }) {
  const p = core.accountProvider(record);
  console.log(`${green('✔')} ${isNew ? 'added' : 'updated'} ${providerTag(p)} ${bold(label)} ${dim(email)} ${dim(`(${core.tierLabel(record) || 'unknown tier'})`)}`);
  console.log(dim(`   tokens stored in ${core.storageDescription()}`));
  if (record.refreshTokenExpiresAt) {
    console.log(dim(`   login valid until ${core.formatLocal(new Date(record.refreshTokenExpiresAt))} (${core.formatRelative(record.refreshTokenExpiresAt - Date.now())})`));
  }
}

async function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function cmdAdd() {
  if (provider() === 'codex') {
    if (!core.readCodexAuth()) fail('no Codex login found (~/.codex/auth.json). Run `usage-bar login --provider codex`, or `codex login` first.');
    reportSaved(await core.captureFromCodex({ label: opts.flags.label }));
    return;
  }
  if (!core.readClaudeCode()) {
    fail('no Claude Code login found. Run `usage-bar login`, or log in via `claude` first.');
  }
  reportSaved(await core.captureFromClaudeCode({ label: opts.flags.label }));
}

async function cmdLogin() {
  const manual = Boolean(opts.flags.manual);
  const codex = provider() === 'codex';
  if (codex && opts.flags.readonly) console.log(dim('`--readonly` applies to Claude logins only — a Codex login always carries the scopes the Codex CLI itself uses.'));
  const session = await core.beginLogin({
    provider: provider(),
    scopes: opts.flags.readonly ? core.LOGIN_SCOPES_READONLY : core.LOGIN_SCOPES_FULL,
    manual,
    useConsole: Boolean(opts.flags.console),
  });
  if (!codex && !opts.flags.readonly) {
    console.log(
      dim('signing in with full Claude Code scopes so `switch` works.\n') +
      dim('for monitoring only, `--readonly` mints a user:profile token that cannot run inference.'),
    );
  }
  if (!codex && session.port && session.port !== core.CALLBACK_PORT) {
    console.log(dim(`port ${core.CALLBACK_PORT} was busy — listening on ${session.port} instead`));
  }
  if (codex && session.port !== core.CODEX_CALLBACK_PORTS[0]) {
    console.log(dim(`port ${core.CODEX_CALLBACK_PORTS[0]} was busy — listening on ${session.port} instead`));
  }

  let pastedCode;
  try {
    if (manual) {
      console.log(`open this URL in a browser signed in to the ${providerName()} account you want to add:\n\n  ${cyan(session.authorizeUrl)}\n`);
      if (!opts.flags['no-open']) core.openBrowser(session.authorizeUrl);
      pastedCode = await promptLine('paste the authorization code shown after approving: ');
      if (!pastedCode) fail('no code entered');
    } else {
      const hint = codex ? 'sign in with the ChatGPT account whose Codex limits you want to watch' : 'a private window or separate browser profile helps when adding a second account';
      console.log(`opening browser for ${providerName()} login… ${dim(`(${hint})`)}`);
      console.log(dim(`if no browser opens, use this URL:\n  ${session.authorizeUrl}`));
      if (!opts.flags['no-open']) core.openBrowser(session.authorizeUrl);
      pastedCode = await session.waitForCode();
    }
  } catch (error) {
    // A port clash cannot reach here: beginLogin() already took a free port (Claude)
    // or failed with its own message (Codex, whose two ports are fixed).
    session.cancel();
    throw error;
  }

  const saved = await core.completeLogin({
    provider: provider(),
    pastedCode,
    state: session.state,
    codeVerifier: session.codeVerifier,
    redirectUri: session.redirectUri,
    label: opts.flags.label,
  });
  reportSaved(saved);
  console.log(dim(`   this login is its own grant — ${clientName()}'s own login and logout do not touch it`));
  if (codex) {
    const codexEmail = core.readCodexAuth() ? core.codexIdentity(core.readCodexAuth().json.tokens).email : null;
    if (codexEmail === saved.email) {
      console.error(yellow(`warn: Codex is signed in as ${saved.email} too. Prefer \`usage-bar add --provider codex\` for the account Codex is currently using, so both share one token chain.`));
    }
    return;
  }
  const claudeEmail = core.readClaudeGlobalConfig()?.oauthAccount?.emailAddress;
  if (claudeEmail === saved.email) {
    console.error(yellow(`warn: Claude Code is signed in as ${saved.email} too. Authorizing the same account twice may invalidate its older token — if Claude Code asks you to log in again, that is why. Prefer \`usage-bar add\` for the account Claude Code is currently using.`));
  }
}

async function cmdList() {
  const index = core.loadIndex();
  if (index.accounts.length === 0) {
    console.log(dim('no accounts tracked. Run `usage-bar login` to add one.'));
    return;
  }
  const records = core.loadRecords(index);
  const live = await core.describeLive(records, { verify: false });
  const labelWidth = Math.max(8, ...records.map((r) => core.displayWidth(r.label)));
  for (const record of records) {
    const p = core.accountProvider(record);
    const active = live[p]?.email && record.email === live[p].email ? green(' active') : '';
    const state = record.missing
      ? red('token missing')
      : [
          record.refreshToken ? 'refreshable' : 'no refresh token',
          `access ${core.isExpired(record, 0) ? yellow('expired') : `valid ${core.formatRelative(record.expiresAt - Date.now())}`}`,
          record.refreshTokenExpiresAt ? `login ${core.formatRelative(record.refreshTokenExpiresAt - Date.now())} left` : null,
          record.source ? `via ${record.source}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
    console.log(`${padVisible(providerTag(p), 9)} ${bold(padVisible(record.label, labelWidth))} ${padVisible(record.email, 28)} ${dim(state)}${active}`);
  }
}

async function cmdRemove() {
  const target = opts.args[0];
  if (!target) fail('usage: usage-bar remove <email|label> [--provider codex]');
  const entry = await core.removeAccount(target, { provider: opts.flags.provider });
  console.log(`${green('✔')} removed ${providerTag(entry.provider)} ${entry.email}`);
}

async function cmdSync() {
  const records = core.loadRecords();
  const only = opts.flags.provider;
  if (!only || only === 'claude') {
    const { live, liveEmail, liveVerified, records: synced } = await core.syncFromLive(records);
    if (!live) console.log(dim('no Claude Code login found'));
    else if (!liveVerified) {
      console.log(
        yellow(
          `! a Claude Code login exists but could not be identified${liveEmail ? ` (it may be ${liveEmail})` : ''} — run \`claude\` once so its token refreshes, then retry`,
        ),
      );
    } else {
      const tracked = synced.some((r) => core.accountProvider(r) === 'claude' && r.email === liveEmail && !r.missing);
      console.log(
        tracked
          ? `${green('✔')} ${providerTag('claude')} ${liveEmail} is up to date`
          : `${yellow('!')} ${liveEmail} is logged in to Claude Code but not tracked — run \`usage-bar add\``,
      );
    }
  }
  if (!only || only === 'codex') {
    const { live, liveEmail, records: synced } = core.syncFromCodex(records);
    if (!live) console.log(dim('no Codex login found'));
    else if (!liveEmail) console.log(yellow('! a Codex login exists but its id_token carries no email — run `codex login` again, then retry'));
    else {
      const tracked = synced.some((r) => core.accountProvider(r) === 'codex' && r.email === liveEmail && !r.missing);
      console.log(
        tracked
          ? `${green('✔')} ${providerTag('codex')} ${liveEmail} is up to date`
          : `${yellow('!')} ${liveEmail} is logged in to Codex but not tracked — run \`usage-bar add --provider codex\``,
      );
    }
  }
}

async function cmdWhoami() {
  const live = await core.describeLive();
  const only = opts.flags.provider;
  const shown = core.PROVIDERS.filter((p) => !only || p === only);
  if (shown.every((p) => !live[p])) fail(`no ${shown.map((p) => core.PROVIDER_CLIENTS[p]).join(' or ')} login found`);
  for (const p of shown) {
    const prefix = only ? '' : `${padVisible(providerTag(p), 9)} `;
    const who = live[p];
    if (!who) console.log(`${prefix}${dim(`not signed in to ${core.PROVIDER_CLIENTS[p]}`)}`);
    else if (!who.email) console.log(`${prefix}${dim('unknown (token expired and no cached email)')}`);
    else console.log(`${prefix}${who.verified ? who.email : `${who.email} ${dim("(unverified — from Claude Code's cached account info)")}`}`);
  }
}

async function cmdSwitch() {
  const target = opts.args[0];
  if (!target) fail('usage: usage-bar switch <email|label> [--provider codex]');
  const result = await core.switchAccount(target, { provider: opts.flags.provider });
  const client = core.PROVIDER_CLIENTS[result.provider];
  if (result.alreadyActive) {
    console.log(`${green('✔')} ${client} already uses ${result.entry.email}`);
    return;
  }
  if (result.untrackedReplaced) {
    console.error(yellow(`warn: the previous login (${result.untrackedReplaced}) was not tracked; its session token has been replaced.`));
  }
  console.log(
    `${green('✔')} ${client} now uses ${providerTag(result.provider)} ${bold(result.entry.label)} ${dim(result.entry.email)}${result.updatedGlobal ? '' : dim(' (account cache in ~/.claude.json not updated)')}`,
  );
  console.log(dim(`   start a new \`${result.provider === 'codex' ? 'codex' : 'claude'}\` session to pick it up`));
  console.log(dim('   a session that is still running keeps its own account — and if it refreshes its token, it writes that account back over this one'));
}

function cmdHelp() {
  console.log(`${bold('usage-bar')} — usage & reset times across several Claude Max/Pro and ChatGPT (Codex) accounts

${bold('usage')}
  usage-bar [status] [--json] [--sort 5h|7d] [--no-sync]   show all tracked accounts (default)
  usage-bar watch [--interval 60]                          live view, redraws every N seconds (requests: ≤1 per ${core.MIN_FETCH_SPACING_MS / 60000} min per account)
  usage-bar login [--label NAME] [--readonly] [--manual]   open the Claude login page and add that account
                     [--no-open]                              (--no-open prints the URL instead of opening a browser)
  usage-bar add [--label NAME]                             capture the account Claude Code is logged in as
  usage-bar list                                           tracked accounts and token state
  usage-bar remove <email|label>                           forget an account (deletes its stored tokens)
  usage-bar sync                                           pull the latest token for each active account from its CLI
  usage-bar switch <email|label>                           make Claude Code (or Codex) use a tracked account without a new login
  usage-bar whoami                                         which account Claude Code and Codex are logged in as
  usage-bar --version | -h                                 version · this help

${bold('codex')}
  Every command takes ${bold('--provider codex')} (or ${bold('--codex')}) to act on OpenAI Codex instead of Claude:
  usage-bar add --provider codex                           capture the ChatGPT account Codex is logged in as (~/.codex/auth.json)
  usage-bar login --provider codex [--label NAME]          sign in to another ChatGPT account for Codex
  usage-bar switch codex:NAME                              point Codex at a tracked account (a codex:/claude: prefix also disambiguates
                                                              remove and switch when one name is tracked for both)

${bold('workflow')}
  usage-bar add                 # the account Claude Code uses now — prefer \`add\` over \`login\` for it
  usage-bar login --label A     # browser opens, sign in, done — repeat per account
  usage-bar add --codex         # the account Codex uses now
  usage-bar                     # or: usage-bar watch

${bold('storage')}
  index    ${core.INDEX_FILE}
  tokens   ${core.storageDescription()}
  env      USAGE_BAR_STORE=file  USAGE_BAR_CONFIG_DIR  CLAUDE_CONFIG_DIR  CODEX_HOME  NO_COLOR`);
}

const commands = {
  status: cmdStatus,
  watch: cmdWatch,
  login: cmdLogin,
  add: cmdAdd,
  list: cmdList,
  ls: cmdList,
  remove: cmdRemove,
  rm: cmdRemove,
  sync: cmdSync,
  switch: cmdSwitch,
  use: cmdSwitch,
  whoami: cmdWhoami,
  help: cmdHelp,
};

// `usage-bar --json | head -1`: the reader going away is not an error worth a stack trace.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

if (opts.flags.version) {
  console.log(`usage-bar ${core.VERSION}`);
  process.exit(0);
}

const handler = commands[opts.command];
if (!handler || opts.flags.help) {
  if (!handler && !opts.flags.help) console.error(red(`unknown command: ${opts.command}\n`));
  cmdHelp();
  process.exit(handler ? 0 : 1);
}

Promise.resolve()
  .then(() => handler())
  .catch((error) => fail(error.message));
