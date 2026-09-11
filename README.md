# Multi-Account Usage Bar

**Every Claude Max/Pro and ChatGPT (Codex) account's rate limits in one place — session, weekly and per-model, with the exact time each one resets.** A CLI and a macOS menu bar app, sharing one account store.

**100% local.** No server, no telemetry, no dependencies. Your tokens stay on your machine and are only ever sent to Anthropic's and OpenAI's own endpoints — the same ones Claude Code and the Codex CLI call for `/usage` and `/status`.

<p align="center"><img src="docs/cli.png" width="760" alt="usage-bar in a terminal"></p>
<p align="center"><img src="docs/menubar.png" width="560" alt="Multi-Account Usage Bar menu bar dropdown"></p>

## Why

Claude Code and the Codex CLI can only tell you about the account they are signed in as. With more than one subscription, checking the others means signing out and back in. This tool keeps its own login per account and shows every window — `5h session`, `7d all`, `7d <model>` — for all of them at once, marked `✳ Claude` and `⬢ Codex`, plus which account has the most headroom right now.

## Install

Requires Node 18+. No build step.

**CLI**

```bash
npm install -g github:kjsik11/multi-account-usage-bar    # gives you the `usage-bar` command
```

**macOS menu bar app**

```bash
git clone https://github.com/kjsik11/multi-account-usage-bar.git
cd multi-account-usage-bar/menubar
make install        # builds, copies to /Applications and launches it
```

The app bundles the CLI, so it needs only Node on your Mac. It is ad-hoc signed, not notarized: if macOS blocks it, right-click the app → Open once, or run `xattr -dr com.apple.quarantine /Applications/MultiAccountUsageBar.app`.

## Add accounts

```bash
usage-bar add                       # the account Claude Code is signed in as — copies its token, no browser
usage-bar login --label personal    # any other account — opens Anthropic's sign-in page
usage-bar add --codex               # the ChatGPT account Codex is signed in as
usage-bar login --codex             # another ChatGPT account
```

Use `add`, not `login`, for the account Claude Code or Codex already uses — signing in to the same account twice can invalidate the CLI's token. For extra accounts, sign in from a private browser window. Every command takes `--provider codex` (or `--codex`) to act on Codex instead of Claude.

In the menu bar app, **Add Account** does the same.

## Use

```bash
usage-bar                     # every account, all windows, reset times
usage-bar watch               # live view
usage-bar --json              # for scripts and status bars
usage-bar list                # accounts and login state
usage-bar switch work         # point Claude Code at another account, no /login
usage-bar switch codex:alt    # same for Codex
usage-bar whoami              # what Claude Code and Codex are signed in as now
usage-bar remove work         # forget an account (deletes its tokens)
```

When one email is tracked for both providers, prefix the name: `codex:alt` or `claude:alt`.

Reading usage does not consume your quota. The usage endpoint throttles hard, so the tool sends at most one request per account every 5 minutes, machine-wide — the CLI, `watch` and the menu bar app share one cache.

## Good to know

- **Storage.** Tokens go to the macOS Keychain (service `multi-account-usage-bar`); on Linux and Windows to `~/.config/multi-account-usage-bar/tokens.json` (mode 0600). Details in [SECURITY.md](SECURITY.md).
- **Login lifetime.** A Claude login lasts about 28 days (Anthropic's limit; refreshing does not extend it). Every view shows how long each login has left and tells you when to sign in again.
- **Codex.** Shows the main 5h / 7d windows only. Its browser login needs port 1455 or 1457 free and has no `--manual` mode.
- **Unofficial.** Not affiliated with Anthropic or OpenAI; the endpoints are internal and may change without notice. Anthropic's Consumer Terms (as clarified in Feb 2026) say Pro/Max OAuth tokens may not be used in other tools — this one only reads your own usage numbers, and a `--readonly` login cannot run inference at all, but use it at your own discretion. `switch` rewrites the credential Claude Code or Codex holds; skip it if you only want to see your limits.

## License

MIT
