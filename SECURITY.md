# Security

This tool holds OAuth tokens for Claude and ChatGPT (Codex) accounts. That makes it worth being precise
about what it stores, where those tokens go, and what the storage does and does not
protect against.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/kjsik11/multi-account-usage-bar/security/advisories/new)
on this repository. Expect an initial response within about a week.

If the issue is in Claude Code or Anthropic's API rather than in this tool, report it
to Anthropic instead: <https://www.anthropic.com/responsible-disclosure>. For the Codex
CLI or OpenAI's API, use OpenAI's programme: <https://openai.com/security/disclosure/>.

## What it stores, and where

| Data | Location | Permissions |
| --- | --- | --- |
| Access + refresh tokens | macOS Keychain, service `multi-account-usage-bar`, one item per account (`<email>` for Claude, `codex:<email>` for Codex) | Keychain ACL |
| Access + refresh tokens (non-macOS, or `USAGE_BAR_STORE=file`) | `~/.config/multi-account-usage-bar/tokens.json` | `0600`, in a `0700` directory |
| Account index (email, label) | `~/.config/multi-account-usage-bar/accounts.json` | `0600` |
| Cached usage numbers, and the address Claude Code's current token resolved to | `~/.config/multi-account-usage-bar/usage-cache.json` | `0600` |
| Claude Code's own login (written only by `switch`, or to hand back a rotated pair) | macOS Keychain, service `Claude Code-credentials`; elsewhere `~/.claude/.credentials.json` | Keychain ACL; `0600`, the directory's mode is Claude Code's and is not changed |
| Claude Code's cached account block (`oauthAccount`, updated only by `switch`) | `~/.claude.json` | the file's existing mode is kept |
| Codex's own login (written only by `switch`, or to hand back a rotated pair) | `~/.codex/auth.json` | `0600`; the directory's mode is Codex's and is not changed |

Writes to all of these files are atomic (write to a temp file, then rename), so an
interrupted write cannot truncate your token store. Every file except `~/.claude.json`
also gets `0600` re-applied on every write, so one that somehow ended up world-readable
is tightened the next time it is written.

## Where data goes

Every network request this tool makes goes to one of these hosts, and nowhere else:

- `claude.ai` / `platform.claude.com` — the OAuth authorize page (opened in your browser)
- `platform.claude.com` / `console.anthropic.com` — token exchange and refresh
- `api.anthropic.com` — the usage and profile endpoints
- `auth.openai.com` — the Codex authorize page, token exchange and refresh
- `chatgpt.com` — the Codex usage endpoint (`/backend-api/wham/usage`)

A Claude token is only ever sent to Anthropic's hosts and a Codex token only to OpenAI's.
There is **no telemetry, no analytics, no crash reporting, and no third-party
dependency at runtime**. Nothing is sent anywhere else, ever. The CLI and the menu-bar
app share one core module, so this holds for both.

## Secrets never reach logs

Error text and terminal output are passed through a redaction pass that strips
token-shaped material (`sk-ant-…`, `sk-…`, OpenAI's `rt.1.…` refresh tokens,
`Bearer …`, JWTs, `access_token`/`refresh_token`/`code_verifier` values) before it
is shown, so a pasted error is safe to put in a bug report. Account emails are shown
in the UI itself — that is the point of the tool.

## What Keychain storage does and does not protect

Storing tokens in the macOS Keychain means they are encrypted at rest and protected
when the Keychain is locked. It does **not** isolate them from other software running
as you:

- This tool reaches the Keychain through the `/usr/bin/security` CLI, so the items'
  ACL trusts that binary. Any process running as your user can therefore read the
  tokens back by invoking `security` itself, without prompting you.
- For the same reason, `security` takes the secret as a command-line argument on
  write, which is briefly visible in `ps` to your own processes. Apple's prompt-based
  alternative truncates at 128 bytes — far below a token record — so it is not usable
  here. Given the ACL above, this does not meaningfully widen the exposure.

The practical takeaway: these tokens are as safe as your user account. Malware running
as you can read them, exactly as it could read Claude Code's own credentials. Full-disk
encryption and not running untrusted code as your user are what actually protect them.

## OAuth handling

- **PKCE (S256)** on every login; the verifier is generated from
  `crypto.randomBytes(32)` and never leaves the process.
- **`state` is verified** on both login paths — compared in constant time against the
  value this session generated. The browser-callback path rejects mismatched
  callbacks with a 404; the manual paste path refuses a pasted `code#state` whose
  state is not ours, which is what stops someone handing you their own authorization
  code to silently attach their account.
- The **callback listener binds `127.0.0.1` only**, never `0.0.0.0`, runs only during
  a login, and times out after 5 minutes. Its response sends `Cache-Control: no-store`,
  a `default-src 'none'` CSP, `Referrer-Policy: no-referrer` and `nosniff`, so the URL
  carrying the authorization code is neither cached nor leaked onward.
- The browser is only ever handed an `https` URL on a Claude or `auth.openai.com` host,
  and is launched without a shell on every platform.
- The Codex callback listens on `127.0.0.1:1455` (or `1457`) — the only two ports OpenAI
  registers for that client — and is state-checked the same way.

## Scopes

`login --readonly` requests `user:profile` only — enough to read usage, not enough to
run inference or be switched to. Use it for accounts you only want to watch. The full
login requests the same scopes Claude Code uses, which is what makes `switch` possible.
A Codex login always requests the scopes the Codex CLI itself uses (`openid profile
email offline_access` plus the connector scopes); there is no read-only variant.

## Token lifetime

Refresh tokens are single-use and rotate on every refresh, for both providers; the tool
writes each rotation back immediately, into its own store and into the CLI's credential
(Claude Code's, or Codex's `auth.json`) when that CLI still holds the pair just spent.
The underlying Claude login lasts about 28 days and is absolute — refreshing does not
extend it. Codex access tokens last 10 days; OpenAI publishes no refresh-token lifetime.
