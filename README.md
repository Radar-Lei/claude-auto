<div align="center">

# claude-glm-auto: auto-continue for Claude Code on GLM

**Hit the 5-hour limit? Connection dropped mid-task? Go do something else.**
<br>
`claude-glm-auto` watches your GLM quota through the official API, waits out the
reset, and continues right where you left off.

[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

</div>

`claude-glm-auto` is a transparent wrapper around the [Claude Code](https://claude.com/claude-code)
CLI for people running it on **GLM** (Zhipu `open.bigmodel.cn` / `api.z.ai`, the
Anthropic-compatible endpoint). It runs `claude` inside a pseudo-terminal and
forwards your keystrokes and Claude's output untouched, so the TUI looks and
behaves **exactly** as it always has.

The difference is what happens when the session stops:

- **The 5-hour token window is spent** (GLM rejects requests with error `1308`):
  the wrapper reads the exact reset time from GLM's quota API, counts the wait
  down in your window title, and sends `continue` the moment the quota is back.
- **A transient error** — `Connection closed mid-response`, self-signed
  certificate trouble, overload: it sends `continue` on a short retry ladder
  (15 s, 30 s, 1 min, 2 min, 5 min), so a dropped response costs seconds, not a
  babysitter.
- **All the while**, the title bar shows where the 5-hour window stands —
  `GLM 5h 64% →1h 58m` — polled from the quota API every five minutes.

This is a fork of [Darkblader24/claude-auto](https://github.com/Darkblader24/claude-auto)
rebuilt around GLM's quota API: the upstream's `/usage` panel scraping, limit
banner wordings, checkpoints and `/low-priority` handling are gone, replaced by
ground truth from the API your Claude Code is already authenticated with.


## Prerequisites

Claude Code must already be running on GLM. The wrapper reads its credentials
the same way Claude Code does:

1. exported `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` win if set;
2. otherwise the `env` block of `$CLAUDE_CONFIG_DIR/settings.json`
   (default `~/.claude/settings.json`) — e.g. the GLM profile at
   `~/.claude_glm/settings.json`:

   ```jsonc
   {
     "env": {
       "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
       "ANTHROPIC_AUTH_TOKEN": "<your GLM key>"
     }
   }
   ```

The token is only ever sent to the quota endpoint on the same host, and never
appears in logs or error messages. Without credentials the wrapper still works
as a plain passthrough — the quota features just stay off.


## Install

From source (this fork isn't on npm):

```bash
git clone https://github.com/Radar-Lei/claude-auto.git
cd claude-auto
bun install && bun run build
npm link        # or: bun link
```

Then alias it so `claude` always starts it:

```bash
claude-glm-auto --install-alias     # --uninstall-alias to undo it
```

It writes the alias into your shell's startup file (`~/.zshrc`, `~/.bashrc`,
`config.fish`, PowerShell's `$PROFILE` — it picks the right one and tells you
which). Safe to re-run. Open a new shell afterwards.

### Pinning a config directory

Multiple Claude Code profiles (e.g. `~/.claude_glm`, `~/.claude_ds`) live or
die on `CLAUDE_CONFIG_DIR`, and a plain alias would drop you on the default
`~/.claude`. Pin the directory at install time and it is written into the
alias line — expanded to an absolute path, so it survives any cwd:

```bash
claude-glm-auto --install-alias --auto-config-dir ~/.claude_glm
```

No flag? Then a `CLAUDE_CONFIG_DIR` already exported in the installing shell
is frozen in; a clean environment installs the plain alias. The flag also
works standalone, for running a one-off session on another profile — and
extra hand-written aliases give each profile its own command:

```bash
alias claude-ds='claude-glm-auto --auto-config-dir ~/.claude_ds'
```

> Migrating from upstream `claude-auto`? Run `claude-auto --uninstall-alias`
> first — the alias markers differ, so the old block wouldn't be removed by the
> new one.


## Usage

`claude-glm-auto` is a **drop-in replacement** for `claude`. All user arguments
are forwarded directly to the real CLI:

```bash
claude-glm-auto                         # same as `claude`
claude-glm-auto -p "explain this"       # same as `claude -p "explain this"`
claude-glm-auto --permission-mode plan  # same as `claude --permission-mode plan`
```

### Auto mode

Sessions start with `--permission-mode auto` passed for you — a wrapper whose
whole job is to keep working while you're away shouldn't stop to ask permission
for every tool call. Override with `--no-auto-mode`, an explicit
`--permission-mode`, or `--dangerously-skip-permissions`.

### Cancelling / taking over

- <kbd>F4</kbd> while a countdown runs cancels it and hands the session back to
  you; detection re-arms immediately.
- **Any other key while an auto-resume is pending does the same** — if you're
  typing, you're driving, and the wrapper will never send `continue` (or wipe
  your draft) from under you.

### Checking your quota

```bash
claude-glm-auto --glm-quota
```

```
GLM quota (open.bigmodel.cn, fetched 11:10:08 PM)
  5h token window : 82% used, resets 9/19/2026, 1:58:04 AM (2h 48m from now)
  MCP monthly     : 12% used (511/4000 calls), resets 10/16/2026, 1:08:43 PM
```


## The title bar

| What you see | What it means |
|:--|:--|
| `✳ working · GLM 5h 64% →1h 58m` | window 64% spent; `→` is the next window shift — when the oldest tokens age out. During a limit wait that moment *is* the resume time |
| `GLM 5h 91% ⚠ →0h 23m` | ≥85% spent — heads-up that a limit is close |
| `GLM 5h 64%? →1h 58m` | last good reading, but the latest poll failed |
| `… · MCP 91%` | the monthly MCP-tool allowance is ≥90% spent (it never blocks the model itself, so it's only ever shown) |
| `⏳ GLM resumes: 1h 23m 45s` | a limit wait is running; at zero the session continues on its own |


## How auto-resume works

Every 2 seconds the wrapper snapshots the **rendered screen** (mirrored into a
headless [xterm](https://github.com/xtermjs/xterm.js), so it sees what you see,
unfooled by redraws and spinners). Independently, every 5 minutes it polls
`GET /api/monitor/usage/quota/limit` on the API host with the same token
Claude Code uses.

Every stop is an `● API Error:` line, and **screen evidence classifies it**:

1. **Limit-shaped** — the message matches GLM's limit wording (`[1308]`,
   `已达到…使用上限`, `usage limit reached`; the monthly variant `每周/每月`
   selects the monthly window's reset). The wait's deadline comes from the
   quota API's `nextResetTime` (precise, epoch-ms), falling back to the reset
   time inside the message, falling back to a 5-minute probe loop that keeps
   re-querying *and* keeps probing with `continue` — a bounded loop, never a
   silent hang.
2. **Transient** — everything else (`Connection closed mid-response`,
   self-signed certificate, 529, stream idle timeout…), *however full the
   quota reads*: a high percentage never turns a transient error into a
   multi-hour wait. It retries on the 15 s → 5 min ladder, which resets after
   ten clean minutes.

During a limit wait the poll keeps running, and two things can end the wait
early or hold it:

- **Early resume**: the 5-hour window reading back below 95% (twice, if no
  spent reading was ever seen) means old tokens aged out ahead of the deadline
  — resume now. An early resume that bounces straight back into the same limit
  disables early resume for that window; only the hard deadline is trusted.
- **Holds**: at resume time, a resume-from-summary question, the
  wait-for-reset menu, or Claude retrying on its own all hold the send; it
  goes out the moment the hold clears.

All recovery paths — deadline, early resume, ladder, probe — funnel through a
single send outlet with a post-send grace, so two sources firing together
can't double-send, and a keystroke or <kbd>F4</kbd> retires every pending
callback at once.

**The guarantee, stated honestly**: while the wrapper process is alive, the
terminal is interactive, and your credentials are valid, a spent 5-hour window
*will* trigger a resume attempt at its reset (or earlier, if the window
clears), and a resume that fails again is simply handled again. Quota coming
back doesn't promise the network, the proxy, or the certificate recovered too
— those the ladder will keep working on at bounded pace.

Further details:

- Detection is skipped while you're scrolled up through history (stale) or
  while Claude asks whether to resume from a summary (your call, nothing is
  typed).
- An error with our `❯ continue` below it is scrollback, never re-handled; a
  genuinely new error renders below that and is acted on afresh.
- The monthly MCP allowance (`TIME_LIMIT`) is displayed, never waited on: when
  it's spent only MCP tool calls fail, the model keeps running.
- Multiple concurrent sessions share one quota pool and each waits on its own;
  they don't coordinate.
- Node's `fetch` doesn't read `HTTP_PROXY` — the quota API is reached
  directly. Fine for direct connections to `open.bigmodel.cn`.
- Nothing is ever written to stdout/stderr during a session (it would corrupt
  the TUI); diagnostics go to the optional `--auto-debug` log.


## Platform support

Linux, macOS, Windows (ConPTY). On Windows, `claude-glm-auto.cmd` runs the
local source without installing anything.


## Development

```bash
bun install
bun run claude          # run from source via tsx
bun run typecheck       # tsc --noEmit
bun run build           # emit dist/claude-glm-auto.js
bash tests/e2e.sh       # E2E suite: fake claude + mock quota API, ~60 s
```

The E2E suite runs the wrapper around `tests/fake-claude.sh` (echoes input,
emits scripted error banners) with the quota API pointed at
`tests/mock-quota.py` (a state file the scenarios flip mid-run), everything at
`CGA_TIME_SCALE=0.01` so five-minute waits compress to three seconds. Eight
scenarios: transient-at-96%-quota, certificate error, ladder escalation,
deadline resume, early resume + bounce + disable, probe loop with the API
down, user takeover, alias install with a pinned config dir.

### Flags & environment

| Flag / variable | Effect |
|:--|:--|
| `--no-auto-mode` | Don't pass `--permission-mode auto` |
| `--install-alias` / `--uninstall-alias` | Manage the `claude` alias in your shell startup file |
| `--auto-config-dir <dir>` | Run on that Claude Code config dir (`~` expanded, absolutised); with `--install-alias` it is written into the alias line |
| `--glm-quota` | Print one quota reading and exit |
| `--auto-debug` | Append screen snapshots and decisions to `claude-glm-auto.log` |
| `GLM_QUOTA_URL` | Override the quota endpoint (what the E2E mock plugs into) |
| `CGA_TIME_SCALE` | Scale every timing constant (E2E uses 0.01; default 1) |


## License

[MIT](LICENSE) © Philipp Köhler, with thanks for the original `claude-auto`.
This fork: MIT likewise.
