#!/usr/bin/env node
import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'node:module';

// ==========================================
// CLI ARGS
// ==========================================
// This wrapper is a drop-in replacement for `claude`: every argument we don't
// recognise is forwarded verbatim to the real CLI. Our own flags are namespaced
// with an `auto-` prefix so they can't collide with claude's (`claude --debug`
// is a real flag), and they are stripped before forwarding.
const AUTO_MODE_OFF_FLAG: string = '--no-auto-mode';
const CONFIG_DIR_FLAG: string = '--auto-config-dir';
const WRAPPER_FLAGS: ReadonlySet<string> = new Set(['--auto-debug', AUTO_MODE_OFF_FLAG]);

// Debug logging is opt-in via a flag (no env var). Pass --auto-debug.
const DEBUG: boolean = process.argv.includes('--auto-debug');

// --auto-config-dir <dir> (or --auto-config-dir=<dir>) pins which Claude Code
// config directory the wrapped claude runs on — ~/.claude, ~/.claude_glm,
// ~/.claude_ds… Claude Code picks its config dir from $CLAUDE_CONFIG_DIR alone,
// so the flag resolves its value once and exports it, from where two consumers
// read it: resolveGlmCredentials() (the quota features' credentials live in that
// dir's settings.json) and the spawned claude itself (via the inherited env).
// Returns the value plus the argv with the flag and its value removed, so the
// rest of forwarding never sees them. A flag with no value is a usage error —
// fail loud rather than silently run on the default config dir.
function parseConfigDirArg(argv: string[]): { value: string | null; rest: string[] } {
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === CONFIG_DIR_FLAG) {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                process.stderr.write(
                    `claude-glm-auto: ${CONFIG_DIR_FLAG} needs a directory (try ${CONFIG_DIR_FLAG} ~/.claude_glm).\n`);
                process.exit(1);
            }
            return { value, rest: [...rest, ...argv.slice(i + 2)] };
        }
        if (arg.startsWith(`${CONFIG_DIR_FLAG}=`)) {
            return { value: arg.slice(CONFIG_DIR_FLAG.length + 1), rest: [...rest, ...argv.slice(i + 1)] };
        }
        rest.push(arg);
    }
    return { value: null, rest };
}

// ~-expand and absolutise. Absolute because both things this value ends up in —
// an alias line in a startup file, and a spawned claude's env — must not depend
// on whatever cwd this happened to run in. A missing directory is refused
// loudly: passing one is a typo waiting to confuse, and the alternative is a
// claude that silently initialises a brand-new config there.
function resolveConfigDir(value: string): string {
    const expanded = value === '~' || value.startsWith('~/')
        ? path.join(os.homedir(), value.slice(1))
        : value;
    const absolute = path.resolve(expanded);
    if (!fs.existsSync(absolute)) {
        process.stderr.write(`claude-glm-auto: config directory not found: ${absolute}\n`);
        process.exit(1);
    }
    return absolute;
}

const { value: configDirArg, rest: argvRest } = parseConfigDirArg(process.argv.slice(2));
if (configDirArg !== null) {
    process.env.CLAUDE_CONFIG_DIR = resolveConfigDir(configDirArg);
}

// Everything after `node claude-glm-auto.ts`, minus our own flags.
const cliArgs: string[] = argvRest.filter(arg => !WRAPPER_FLAGS.has(arg));

// Sessions start in auto mode: we forward `--permission-mode auto` by default, so
// claude-glm-auto doesn't stop to ask on every tool call — the point of the wrapper is
// to keep going while you're away. Three things opt out of it:
//   * --no-auto-mode, ours, for when you just want claude's own default;
//   * an explicit --permission-mode, which is you naming a mode, so it wins;
//   * --dangerously-skip-permissions, which claude rejects alongside a mode.
const AUTO_MODE: string = 'auto';
const PERMISSION_MODE_FLAG: string = '--permission-mode';
const SKIP_PERMISSIONS_FLAG: string = '--dangerously-skip-permissions';

function permissionModeArgs(args: string[]): string[] {
    if (process.argv.includes(AUTO_MODE_OFF_FLAG)) return [];
    const alreadySet: boolean = args.some(arg =>
        arg === PERMISSION_MODE_FLAG ||
        arg.startsWith(`${PERMISSION_MODE_FLAG}=`) ||
        arg === SKIP_PERMISSIONS_FLAG
    );
    return alreadySet ? [] : [PERMISSION_MODE_FLAG, AUTO_MODE];
}

const forwardedArgs: string[] = [...cliArgs, ...permissionModeArgs(cliArgs)];

// ==========================================
// CONFIG
// ==========================================
// One scale factor for every timing constant. Production never sets it
// (scale 1); the E2E suite runs at 0.01 so five-minute waits compress to
// three seconds. Anything non-positive or unparseable falls back to 1.
const TIME_SCALE: number = (() => {
    const v: number = Number.parseFloat(process.env.CGA_TIME_SCALE ?? '1');
    return Number.isFinite(v) && v > 0 ? v : 1;
})();
const scaled = (ms: number): number => Math.max(1, Math.round(ms * TIME_SCALE));

// Any API error, rendered into the transcript as "● API Error: …". With GLM this
// covers both the 5-hour-window limit (error 1308, with a reset time in the
// message) and transient failures (connection dropped mid-response, overloaded,
// proxy/TLS trouble). Which one it is — and therefore how long to wait — is
// decided against the GLM quota API, not the banner text alone.
// Whitespace is loose because the line can be re-wrapped at narrow widths.
const apiErrorRegex: RegExp = /●\s*API Error:/i;

// --- Error classification --------------------------------------------------
// What a GLM limit looks like on the rendered screen. The 5-hour window
// rejects requests with HTTP 429 + error code 1308 and a Chinese message
// carrying the reset time (confirmed from real transcripts):
//
//   ● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。
//   您的限额将在 2026-09-07 17:00:30 重置。][...]
//
// The monthly allowance has its own wording (每周/每月) and its reset is the
// *monthly* window's, days out. Both are limit-shaped: the request was
// throttled, so "continue" before the reset would only fail again. Anything
// else — connection closed mid-response, self-signed certificate, 529
// overload, stream idle timeout — is transient, however full the quota reads:
// a high percentage must never turn a transient error into a multi-hour wait.
const LIMIT_ERROR_PATTERNS: RegExp[] = [
    /\[?1308\]?/,                            // GLM's 5-hour window error code
    /已达到[\s\S]{0,40}?使用上限/,             // "…使用上限…" (5-hour and monthly)
    /usage\s+limit\s+(?:reached|exceeded)/i,  // English wording, just in case
];
// Which window a limit message names — its reset time is the one that counts.
const MONTHLY_LIMIT_PATTERN: RegExp = /每周|每月/;
// "2026-09-07 17:00:30" inside a limit message: local time on both ends — the
// TUI renders local, we parse local — so no timezone to guess.
const BANNER_RESET_TIME_REGEX: RegExp =
    /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/;
// Claude Code's own retry backoff, e.g. "Retrying in 32 seconds…". While it's
// up, Claude hasn't given up on the request — sending "continue" would queue
// text into a busy session — so a resume holds until it's gone. Best-effort
// by design: absence of the hint doesn't prove idle, but presence reliably
// means busy, and a held resume simply retries on its next tick.
const RETRY_HINT_REGEX: RegExp = /retry(?:ing)?[^a-z]{0,3}in\s+\d+\s*(?:s|sec|second)/i;

// Transient errors retry on a ladder: fast at first (a dropped connection is
// usually back immediately), slower as failures stack (a broken proxy won't
// heal in 15 seconds and hammering it helps nobody). The ladder resets only
// after TRANSIENT_RESET_TICKS consecutive clean screen captures (2s each =
// 10 min) — captures skipped while a wait, menu or grace period ran don't
// count, so a pause can't age a persistent failure away.
const TRANSIENT_DELAYS_MS: readonly number[] = [15e3, 30e3, 60e3, 120e3, 300e3].map(scaled);
const TRANSIENT_RESET_TICKS: number = Math.max(1, Math.round(300 * TIME_SCALE));

// After any resume send, error handling pauses this long: the "❯ continue"
// echo takes a moment to render, and re-detecting the same error inside that
// window would double-send. If the echo never lands, the first capture after
// the grace re-triggers handling — one rung up the ladder.
const SEND_GRACE_MS: number = scaled(5000);

// A limit wait with no usable reset time (quota API down, no time in the
// message) probes on this cadence: each round re-queries for a deadline AND
// sends one probing "continue" — a transient error heals on the probe, a
// true limit shrugs it off at harmless 5-minute spacing. Bounded, never a
// silent hang.
const PROBE_INTERVAL_MS: number = scaled(5 * 60 * 1000);

// When an early resume bounces straight back into the same limit and the new
// wait also has no deadline to trust, early resume stays off for this long.
const EARLY_RESUME_FALLBACK_MS: number = scaled(2 * 60 * 60 * 1000);

// ==========================================
// GLM QUOTA API
// ==========================================
// GLM (bigmodel.cn) exposes the quotas that actually gate a session through an
// authenticated GET — using the very credentials Claude Code itself runs on —
// so the wrapper reads ground truth instead of scraping a panel. Two windows
// come back:
//
//   TOKENS_LIMIT  the 5-hour rolling token window. This is the one that stops
//                 a session outright: when it's spent, requests fail with
//                 error 1308 and a reset time in the message.
//   TIME_LIMIT    the monthly MCP tool-call allowance. When it's spent only
//                 MCP calls fail; the model keeps running, so it never blocks
//                 a session and is displayed, never waited on.
//
// Each carries `percentage` (0-100 spent) and `nextResetTime` (epoch ms). That
// stamp is the authoritative resume time for a spent 5-hour window: no screen
// parsing, no timezone arithmetic, no am/pm.
const QUOTA_API_PATH: string = '/api/monitor/usage/quota/limit';

// The monitor endpoint lives on the same host as the Anthropic-compatible API,
// so the URL is derived from ANTHROPIC_BASE_URL's origin. GLM_QUOTA_URL
// overrides it wholesale — that's the seam the E2E mock plugs into.
const QUOTA_URL_OVERRIDE_ENV: string = 'GLM_QUOTA_URL';

// Standing poll cadence for the title bar, and how long a request may take.
// Five minutes matches how fast a 5-hour window visibly moves; a slow poll
// never blocks anything (detection and resumes don't wait on it).
const QUOTA_POLL_INTERVAL_MS: number = scaled(5 * 60 * 1000);
const QUOTA_FETCH_TIMEOUT_MS: number = 8000;

// Consecutive failed polls back off exponentially up to this — the API is a
// nicety, and a struggling monitor endpoint must not be hammered.
const QUOTA_BACKOFF_MAX_MS: number = 20 * 60 * 1000;

// After a failure, no *error-triggered* confirmation query before this long
// (the standing poll is unaffected): a banner seen while the quota API is down
// shouldn't re-query it every 2-second screen capture.
const QUOTA_RETRY_AFTER_FAIL_MS: number = 60 * 1000;

// A limit is confirmed when the 5-hour window reads at least this spent, on a
// query that follows a limit-shaped banner. 1308 means the window is truly
// full, but between the request failing and our query landing, tokens can age
// out of the rolling window — 95 leaves room for that drift while still being
// a reading the API only reports when the window is effectively spent. The
// same number doubles as the early-resume line: a window that has fallen back
// below it during a countdown has room again.
const LIMIT_CONFIRM_PCT: number = 95;

// Title-bar thresholds: warn on the 5-hour window from here, and mention the
// monthly MCP allowance from here (it stays off the title otherwise — it never
// blocks a session, so it doesn't deserve the width).
const QUOTA_WARN_PCT: number = 85;
const MCP_WARN_PCT: number = 90;

interface GlmCredentials {
    baseUrl: string;
    token: string;
}

// Resolved once at startup. Exported env vars win (an explicit override), then
// the settings.json Claude Code itself reads — $CLAUDE_CONFIG_DIR if set,
// ~/.claude otherwise — whose `env` block carries the GLM base URL and token.
// A half-pair from either source is not combined across sources: mixing a
// token from one place with a base URL from another is how silent wrong-account
// reads happen, so each source has to be complete on its own or we return null
// and every quota feature quietly stays off. The session itself never depends
// on them.
function resolveGlmCredentials(): GlmCredentials | null {
    const pair = (baseUrl: string | undefined, token: string | undefined): GlmCredentials | null =>
        baseUrl && token ? { baseUrl, token } : null;

    const fromEnv: GlmCredentials | null =
        pair(process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_AUTH_TOKEN);
    if (fromEnv !== null) return fromEnv;

    const configDir: string = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    try {
        const settings = JSON.parse(
            fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'),
        ) as { env?: Record<string, string | undefined> };
        return pair(settings.env?.ANTHROPIC_BASE_URL, settings.env?.ANTHROPIC_AUTH_TOKEN);
    } catch {
        return null; // no settings.json, or not JSON — nothing to read there
    }
}

// The monitor URL for a base URL, or null when the base URL isn't parseable.
// origin normalises protocol/host/port and drops the /api/anthropic path.
function quotaApiUrl(baseUrl: string): string | null {
    try {
        return new URL(baseUrl).origin + QUOTA_API_PATH;
    } catch {
        return null;
    }
}

interface QuotaWindow {
    percentage: number;           // percent of the window spent (0-100)
    nextResetTime: number | null; // epoch ms; null when absent or implausible
    currentUsage: number | null;  // TIME_LIMIT only: calls made this month
    capacity: number | null;      // TIME_LIMIT only: calls allowed per month
}

interface QuotaSnapshot {
    tokens: QuotaWindow | null;  // TOKENS_LIMIT — the 5-hour window
    monthly: QuotaWindow | null; // TIME_LIMIT — monthly MCP calls (display only)
    fetchedAt: number;           // Date.now() at parse, for staleness marks
}

// One window out of a limits[] entry, or null when the entry isn't usable.
// percentage and nextResetTime are validated *independently*: a garbled stamp
// must not throw away a valid percentage (the title bar still wants it), nor a
// valid stamp a garbled percentage. A stamp outside (now-1h, now+35d) is
// treated as absent rather than trusted: a month covers the monthly window
// with room to spare, and an hour of clock skew still lets a *just-past* reset
// through to the countdown clamp instead of dying here.
function parseQuotaWindow(entry: unknown, now: number): QuotaWindow | null {
    if (typeof entry !== 'object' || entry === null) return null;
    const fields = entry as {
        percentage?: unknown;
        nextResetTime?: unknown;
        currentValue?: unknown;
        usage?: unknown;
    };

    const pct: number =
        typeof fields.percentage === 'number' && Number.isFinite(fields.percentage)
            ? fields.percentage
            : Number.NaN;
    if (Number.isNaN(pct)) return null;

    const stamp: number =
        typeof fields.nextResetTime === 'number' && Number.isFinite(fields.nextResetTime)
            ? fields.nextResetTime
            : Number.NaN;
    const reset: number | null = !Number.isNaN(stamp)
        && stamp > now - 60 * 60 * 1000
        && stamp < now + 35 * 24 * 60 * 60 * 1000
        ? stamp
        : null;

    const count = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;

    return {
        percentage: pct,
        nextResetTime: reset,
        currentUsage: count(fields.currentValue),
        capacity: count(fields.usage),
    };
}

// The raw JSON body into a snapshot, or null when it isn't the shape we came
// for. Strictness here is cheap insurance: anything doubtful becomes null, and
// every consumer treats null as "no data" — never as "no limit".
function parseQuotaResponse(body: unknown): QuotaSnapshot | null {
    if (typeof body !== 'object' || body === null) return null;
    const { code, data } = body as { code?: unknown; data?: unknown };
    if (code !== 200 || typeof data !== 'object' || data === null) return null;

    const limits: unknown = (data as { limits?: unknown }).limits;
    if (!Array.isArray(limits)) return null;

    const now: number = Date.now();
    let tokens: QuotaWindow | null = null;
    let monthly: QuotaWindow | null = null;
    for (const entry of limits) {
        const type: unknown = (entry as { type?: unknown }).type;
        if (type === 'TOKENS_LIMIT' && tokens === null) tokens = parseQuotaWindow(entry, now);
        if (type === 'TIME_LIMIT' && monthly === null) monthly = parseQuotaWindow(entry, now);
    }
    if (tokens === null && monthly === null) return null;
    return { tokens, monthly, fetchedAt: now };
}

// Fetch and parse in one step. Authorization is the bare token — GLM's monitor
// API wants no Bearer prefix. The token never reaches a log line: failures log
// at most an HTTP status or the error's *name*, never its message.
async function fetchQuotaSnapshot(creds: GlmCredentials): Promise<QuotaSnapshot | null> {
    const url: string = process.env[QUOTA_URL_OVERRIDE_ENV] ?? quotaApiUrl(creds.baseUrl) ?? '';
    if (url === '') {
        log('quota API: base URL not parseable');
        return null;
    }
    try {
        const res = await fetch(url, {
            headers: { authorization: creds.token },
            signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            log(`quota API: HTTP ${res.status}`);
            return null;
        }
        const snap = parseQuotaResponse(await res.json());
        if (snap === null) log('quota API: response not in the expected shape');
        return snap;
    } catch (err) {
        log(`quota API: ${err instanceof Error ? err.name : 'request failed'}`);
        return null;
    }
}

// Claude sometimes offers a "Stop and wait for limit to reset" menu; we select it
// (press Enter) so the session parks until reset. Wait briefly so the menu has
// fully rendered, then ignore it for a grace period so the redraw doesn't make
// us press Enter twice.
const MENU_PROMPT_TEXT: string = '❯ stop and wait for limit to reset';
const MENU_ENTER_DELAY_MS: number = scaled(2000);
const MENU_GRACE_MS: number = scaled(5000);

// When this substring is on screen the user is scrolled up through history
// (it's the "(ctrl+End) ↓" jump-to-bottom hint). What we read in that state is
// stale scrollback, so we skip detection entirely.
const SCROLL_INDICATOR: string = ') ↓';

// Resuming an old, large session makes Claude ask whether to summarise it first
// ("This session is 3h old and 150K tokens" → "Resume from summary
// (recommended)" / "Resume full session as-is" / "Don't ask me again"). That
// question is a select menu, so any Enter we send answers it — and the default
// choice compacts the conversation. Worse, the limit banner from the session
// we're resuming is usually still on screen behind it, so detection would fire
// right into the menu. While the question is up we type nothing at all.
// Matched against the first option's label: short enough not to wrap.
const RESUME_PROMPT_TEXT: string = '❯ resume from summary';

// Safety margin added on top of the quota API's nextResetTime before we resume.
const WAIT_BUFFER_MS: number = scaled(60 * 1000);

// A reset time that is already in the past still has to leave a gap before we
// resume, or a limit that's in fact still live would spin: resume, banner,
// re-check, resume, seconds apart. It happens when a reset has only just gone
// by, and for as long as hours if the machine's clock is offset — nextResetTime
// is an epoch-ms stamp, so this is the backstop for clock skew.
const MIN_WAIT_MS: number = scaled(5 * 60 * 1000);

// The text sent to continue a session
const RESUME_CONTINUE_TEXT: string = 'continue';

// On resume we submit "continue", which Claude echoes into the transcript just
// below the limit banner we waited out. So a banner with our continue beneath it
// is one we've already resumed past — stale scrollback — and detection skips it.
// This is what stops the just-waited-out limit re-triggering, with no time window
// to tune: a genuinely new limit renders below the last continue, so its banner
// has nothing after it and is still verified.
//
// The string must match how Claude renders our submitted message. If that ever
// changes, a stale banner would be re-detected — one quota check, then a wait —
// a safe failure, but confirm it against an --auto-debug screen capture
// (logScreen writes exactly what we match here).
const RESUME_CONTINUE_MARKER: string = '❯ ' + RESUME_CONTINUE_TEXT;

// A limit banner or API error with this marker below it is scrollback, not a
// live stop.
const HANDLED_STOP_MARKERS: readonly string[] = [RESUME_CONTINUE_MARKER];

// Ctrl-U clears the input line in Claude Code; the draft can wrap, so we fire it
// a few times to wipe the whole composer before typing our own command.
const CLEAR_INPUT_SEQUENCE: string = '\x15'.repeat(8);

// F4 cancels an in-progress countdown. Terminals send F4 either as the SS3
// sequence ESC O S or as the CSI form ESC [ 14 ~; we match both.
const F4_SEQUENCES: string[] = ['\x1bOS', '\x1b[14~'];

// How often we snapshot the rendered screen in debug mode (and run limit detection on it).
const SCREEN_CAPTURE_INTERVAL_MS: number = scaled(2000);
const LOG_FILE: string = path.join(process.cwd(), 'claude-glm-auto.log');

function log(msg: string): void {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        /* logging must never crash the wrapper */
    }
}

// ==========================================
// ALIAS INSTALL
// ==========================================
// `alias claude=claude-glm-auto` typed at a prompt lives and dies with that shell —
// on every platform, Linux included. No shell persists an alias for you (fish's
// `alias --save` is the one exception), so to make it stick the line has to sit
// in a startup file the shell re-reads on every launch. --install-alias puts it
// there, --uninstall-alias takes it back out.
//
// The line is fenced between markers, which is what makes both idempotent: we
// only ever rewrite what's between our own markers, so re-installing doesn't
// stack up duplicates and uninstalling can't take a line the user wrote with it.
const ALIAS_INSTALL_FLAG: string = '--install-alias';
const ALIAS_UNINSTALL_FLAG: string = '--uninstall-alias';
const ALIAS_BEGIN: string = '# >>> claude-glm-auto alias >>>';
const ALIAS_END: string = '# <<< claude-glm-auto alias <<<';

// Colour the final verdict so it can't be missed in a wall of per-file output.
// NO_COLOR / a non-TTY stdout means the codes would just be noise, so drop them.
function colorize(code: string, msg: string): string {
    const on: boolean = process.stdout.isTTY === true && !process.env.NO_COLOR;
    return on ? `\x1b[${code}m${msg}\x1b[0m` : msg;
}
const green = (msg: string): string => colorize('32', msg);
const red = (msg: string): string => colorize('31', msg);

interface AliasTarget {
    shell: string;  // what to call it when we report back
    file: string;   // the startup file to edit
    line: string;   // the alias, in that shell's syntax
    reload: string; // how to pick it up without opening a new shell
}

// The flag clause appended to a POSIX alias line, or '' when nothing is pinned.
// The path is double-quoted: inside bash/zsh's single-quoted alias body a double
// quote is literal, and it keeps a path with spaces one argument for the wrapper.
function posixConfigClause(configDir: string | null): string {
    return configDir === null ? '' : ` ${CONFIG_DIR_FLAG} "${configDir}"`;
}

// Which file a POSIX shell actually re-reads on launch. Nothing here is a guess
// we can make from the OS alone — it's the shell that decides, so we read $SHELL.
function posixTarget(configDir: string | null): AliasTarget | null {
    const name: string = path.basename(process.env.SHELL ?? '');
    const home: string = os.homedir();
    const clause = posixConfigClause(configDir);

    if (name.includes('fish')) {
        const file: string = path.join(home, '.config', 'fish', 'config.fish');
        return { shell: 'fish', file, line: `alias claude claude-glm-auto${clause}`, reload: `source ${file}` };
    }
    if (name.includes('zsh')) {
        // ZDOTDIR moves the whole zsh config elsewhere; when it's set, .zshrc there is the one being read.
        const file: string = path.join(process.env.ZDOTDIR || home, '.zshrc');
        return { shell: 'zsh', file, line: `alias claude='claude-glm-auto${clause}'`, reload: `source ${file}` };
    }
    if (name.includes('bash')) {
        // On macOS, Terminal.app opens *login* shells, which read .bash_profile and
        // never .bashrc. Everywhere else .bashrc is the interactive-shell file.
        const file: string = path.join(home, os.platform() === 'darwin' ? '.bash_profile' : '.bashrc');
        return { shell: 'bash', file, line: `alias claude='claude-glm-auto${clause}'`, reload: `source ${file}` };
    }
    return null;
}

// PowerShell knows where its own profile lives ($PROFILE), and the path isn't
// reliably derivable from outside — Documents can be redirected to OneDrive, and
// pwsh and Windows PowerShell use different folders. So we ask each one that's
// installed, and install into every profile we get back: the user may well use both.
// A pinned config dir needs the wrapper's own flag on the command line, which
// Set-Alias can't carry — that case becomes a function (the @args splat keeps it
// a drop-in `claude` replacement); without one it stays a plain alias.
function powershellTargets(configDir: string | null): AliasTarget[] {
    const targets: AliasTarget[] = [];
    for (const exe of ['pwsh', 'powershell']) {
        try {
            const file: string = execFileSync(exe, ['-NoProfile', '-Command', '$PROFILE'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            // Same profile from both exes would mean editing one file twice.
            if (file && !targets.some(t => t.file === file)) {
                targets.push({
                    shell: exe,
                    file,
                    line: configDir === null
                        ? 'Set-Alias claude claude-glm-auto'
                        : `function claude { claude-glm-auto ${CONFIG_DIR_FLAG} '${configDir.replace(/'/g, "''")}' @args }`,
                    reload: `. $PROFILE`
                });
            }
        } catch {
            /* not installed, or refused to run — try the other one */
        }
    }
    return targets;
}

// Which config directory an installed alias should pin, or null for none. The
// flag wins; otherwise a CLAUDE_CONFIG_DIR already exported in the installing
// shell is frozen in, so the alias keeps running the config you installed it
// from even in shells that never export it; a clean environment installs the
// plain alias, where claude picks its own default (~/.claude). Both sources go
// through the same ~-expanding absolutiser, so what's frozen never depends on
// the cwd at install time. (When the flag was passed, the CLI-args section has
// already exported CLAUDE_CONFIG_DIR, so both sources read the same value.)
function resolveAliasConfigDir(): string | null {
    const value = configDirArg ?? process.env.CLAUDE_CONFIG_DIR ?? null;
    return value === null ? null : resolveConfigDir(value);
}

function aliasTargets(configDir: string | null): AliasTarget[] {
    // The shell we were launched from decides this, not the platform: Git Bash and
    // MSYS run on Windows, set $SHELL, and read the usual POSIX startup files. So a
    // POSIX shell wins wherever we find one, and PowerShell is what "Windows, and no
    // $SHELL" means. (cmd.exe also lands here — it has no startup file at all, which
    // is why the empty-targets message below sends those users to PowerShell.)
    const posix: AliasTarget | null = posixTarget(configDir);
    if (posix) return [posix];
    return os.platform() === 'win32' ? powershellTargets(configDir) : [];
}

// A startup file we didn't create is the user's file, so we leave its line
// endings the way we found them — a PowerShell $PROFILE is normally CRLF, and
// silently rewriting the whole thing to LF is not ours to do.
function eolOf(text: string): string {
    if (text === '') return os.EOL;
    return text.includes('\r\n') ? '\r\n' : '\n';
}

// Drop our fenced block, if it's there. Everything outside the markers is the
// user's and comes back out untouched.
function stripAliasBlock(text: string): string {
    const eol: string = eolOf(text);
    const kept: string[] = [];
    let inBlock: boolean = false;
    for (const line of text.split(/\r?\n/)) {
        if (!inBlock && line.trim() === ALIAS_BEGIN) { inBlock = true; continue; }
        if (inBlock) {
            if (line.trim() === ALIAS_END) inBlock = false;
            continue;
        }
        kept.push(line);
    }
    // An unterminated block (someone deleted the end marker) would swallow the rest
    // of the file, so in that case we keep the original and let the caller notice.
    return inBlock ? text : kept.join(eol);
}

function readIfExists(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return ''; // no startup file yet — a fresh PowerShell install has none
    }
}

function writeAliasFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

// Both commands report to stdout: here the output *is* the point, and the pty
// doesn't exist yet, so there's no TUI to corrupt. Returns the process exit code.
function runAliasCommand(install: boolean): number {
    // Uninstall just drops the fenced block — what it pinned doesn't matter.
    const configDir: string | null = install ? resolveAliasConfigDir() : null;
    const targets: AliasTarget[] = aliasTargets(configDir);
    const out = (msg: string): void => { process.stdout.write(msg + '\n'); };

    if (targets.length === 0) {
        out(
            "claude-glm-auto: couldn't work out which shell to write to.\n" +
            '  Add the alias to your shell\'s startup file by hand:\n' +
            "    bash/zsh   alias claude='claude-glm-auto'      (~/.bashrc, ~/.zshrc)\n" +
            '    fish       alias --save claude claude-glm-auto\n' +
            '    PowerShell Set-Alias claude claude-glm-auto    ($PROFILE)\n' +
            '  To pin a config directory (e.g. ~/.claude_glm instead of ~/.claude),\n' +
            `  append: ${CONFIG_DIR_FLAG} "/absolute/path/to/dir"\n` +
            '  cmd.exe has no startup file: a permanent doskey macro needs the\n' +
            '  Command Processor AutoRun registry key. Use PowerShell instead.'
        );
        out(red(`claude-glm-auto: alias ${install ? 'install' : 'uninstall'} failed.`));
        return 1;
    }

    let changed: number = 0;
    for (const target of targets) {
        const before: string = readIfExists(target.file);
        const hasBlock: boolean = before.includes(ALIAS_BEGIN);

        // Nothing of ours in the file: there is nothing to take out, and rewriting
        // it just to reformat what's already there would be pure vandalism.
        if (!install && !hasBlock) {
            out(`claude-glm-auto: nothing to do — no claude-glm-auto alias in ${target.file}.`);
            continue;
        }

        const stripped: string = stripAliasBlock(before);
        if (hasBlock && stripped === before) {
            out(`claude-glm-auto: ${target.file} has an unterminated claude-glm-auto block — fix it by hand.`);
            continue;
        }

        // Uninstall is just the strip. Install re-appends, so an existing block is
        // replaced rather than duplicated (and picks up any change to the syntax).
        const eol: string = eolOf(before);
        const body: string = stripped.replace(/\s+$/, '');
        const after: string = install
            ? `${body ? body + eol + eol : ''}${ALIAS_BEGIN}${eol}${target.line}${eol}${ALIAS_END}${eol}`
            : (body ? body + eol : '');

        if (after === before) {
            out(`claude-glm-auto: nothing to do — ${target.file} is already set up.`);
            continue;
        }

        try {
            writeAliasFile(target.file, after);
        } catch (err) {
            out(`claude-glm-auto: couldn't write ${target.file} — ${String(err)}`);
            out(red(`claude-glm-auto: alias ${install ? 'install' : 'uninstall'} failed.`));
            return 1;
        }
        changed++;
        out(install
            ? `claude-glm-auto: added "${target.line}" to ${target.file} (${target.shell})`
            : `claude-glm-auto: removed the alias from ${target.file} (${target.shell})`);
        out(`  Open a new shell, or run: ${target.reload}`);
    }

    // A profile that PowerShell refuses to execute is loaded by nobody, so the
    // alias we just wrote would silently never appear.
    if (install && changed > 0 && os.platform() === 'win32') warnIfProfilesBlocked();
    out(green(
        `claude-glm-auto: alias ${install ? 'install' : 'uninstall'} successful! ` +
        'Restart your terminal for it to take effect.'
    ));
    return 0;
}

function warnIfProfilesBlocked(): void {
    try {
        const policy: string = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-ExecutionPolicy'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (/^(Restricted|AllSigned)$/i.test(policy)) {
            process.stdout.write(
                `\nHeads up: your PowerShell execution policy is ${policy}, so profile scripts don't run\n` +
                '  and the alias will never load. Allow local scripts with:\n' +
                '    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned\n'
            );
        }
    } catch {
        /* couldn't ask — not worth failing the install over */
    }
}

if (process.argv.includes(ALIAS_INSTALL_FLAG) || process.argv.includes(ALIAS_UNINSTALL_FLAG)) {
    process.exit(runAliasCommand(process.argv.includes(ALIAS_INSTALL_FLAG)));
}

// ==========================================
// QUOTA PROBE (--glm-quota)
// ==========================================
// Print one quota reading and exit, before any pty exists — so stdout is ours
// and there's no TUI to corrupt. It's the natural test probe (credentials,
// request and parser all exercised without a session) and a handy CLI besides.
const QUOTA_FLAG: string = '--glm-quota';

function formatDuration(ms: number): string {
    const totalMinutes: number = Math.max(0, Math.round(ms / 60000));
    const h: number = Math.floor(totalMinutes / 60);
    const m: number = totalMinutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function printQuotaAndExit(): Promise<never> {
    const creds: GlmCredentials | null = resolveGlmCredentials();
    if (creds === null) {
        process.stderr.write(
            'claude-glm-auto: no GLM credentials found.\n' +
            '  Export ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, or point\n' +
            '  CLAUDE_CONFIG_DIR at a settings.json whose env block has them.\n',
        );
        process.exit(1);
    }

    const snap: QuotaSnapshot | null = await fetchQuotaSnapshot(creds);
    if (snap === null || snap.tokens === null) {
        process.stderr.write('claude-glm-auto: quota API request failed.\n');
        process.exit(1);
    }

    const host: string = new URL(creds.baseUrl).host;
    const lines: string[] = [`GLM quota (${host}, fetched ${new Date().toLocaleTimeString()})`];

    const tokens: QuotaWindow = snap.tokens;
    const reset: string = tokens.nextResetTime === null
        ? 'reset time unknown'
        : `resets ${new Date(tokens.nextResetTime).toLocaleString()}`;
    lines.push(`  5h token window : ${tokens.percentage}% used, ${reset}` +
        (tokens.nextResetTime === null ? '' : ` (${formatDuration(tokens.nextResetTime - Date.now())} from now)`));

    if (snap.monthly !== null) {
        const calls: string = snap.monthly.currentUsage !== null && snap.monthly.capacity !== null
            ? ` (${snap.monthly.currentUsage}/${snap.monthly.capacity} calls)`
            : '';
        const monthlyReset: string = snap.monthly.nextResetTime === null
            ? 'reset time unknown'
            : `resets ${new Date(snap.monthly.nextResetTime).toLocaleString()}`;
        lines.push(`  MCP monthly     : ${snap.monthly.percentage}% used${calls}, ${monthlyReset}`);
    }

    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
}

// Top-level await keeps the pty (and Claude itself) from spawning underneath an
// in-flight probe: nothing below this line runs until the probe has exited.
if (process.argv.includes(QUOTA_FLAG)) {
    await printQuotaAndExit();
}

// ==========================================
// SELF-CALL GUARD
// ==========================================
// A shell alias (`alias claude=claude-glm-auto`) can't reach us: aliases are never
// exported and we exec directly, not through a shell. But a *script* named
// `claude` on PATH pointing back here would be found when we spawn `claude`,
// and we'd fork-bomb. We mark the child's environment; seeing that mark on
// startup means we're about to wrap ourselves.
const ACTIVE_ENV: string = 'CLAUDE_GLM_AUTO_ACTIVE';

if (process.env[ACTIVE_ENV] === '1') {
    // Safe to write here: the pty doesn't exist yet, so there's no TUI to corrupt.
    process.stderr.write(
        'claude-glm-auto: refusing to wrap itself — "claude" on your PATH points back at claude-glm-auto.\n' +
        `  Alias it instead of installing it under the name "claude": claude-glm-auto ${ALIAS_INSTALL_FLAG}\n`
    );
    process.exit(1);
}

// ==========================================
// SPAWN CLAUDE
// ==========================================
const cols: number = process.stdout.columns || 80;
const rows: number = process.stdout.rows || 24;

// `claude` is a shell shim on Windows, so it can only be launched through cmd.exe.
const shell = os.platform() === 'win32' ? 'cmd.exe' : 'claude';
const args = os.platform() === 'win32'
    ? ['/c', 'claude', ...forwardedArgs]
    : forwardedArgs;

const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, [ACTIVE_ENV]: '1' } as Record<string, string>,
    useConpty: true,
    // Use the standalone conpty.dll bundled with node-pty for better redraw
    // fidelity than the older in-box Windows ConPTY.
    useConptyDll: true
});


// @xterm/headless ships a CJS bundle whose named exports Node's ESM loader can't
// statically detect, so we pull Terminal in via require() (this project runs
// under tsx). The cast restores the proper types from the package typings.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

// A headless terminal mirrors Claude's TUI so we can read the *rendered* screen
// (the grid of characters the user actually sees) instead of the raw escape
// sequence stream. node-pty feeds it; we never display it.
// allowProposedApi is required to read `term.buffer` in this xterm version.
const term = new Terminal({ cols, rows, allowProposedApi: true });

// ==========================================
// DETECTION STATE
// ==========================================
let isWaiting: boolean = false;     // a confirmed limit countdown is running
let isVerifying: boolean = false;   // a quota API query is in flight
let isHandlingMenu: boolean = false; // selecting the wait-for-reset menu
let countdownInterval: NodeJS.Timeout | null = null;
let captureInterval: NodeJS.Timeout | null = null;
let currentScreen: string = '';

// ==========================================
// WINDOW TITLE
// ==========================================
// The countdown takes the window title over, so it has to put back whatever was
// there before. xterm's title stack (ESC[22;0t to push, ESC[23;0t to pop) does
// that in one sequence, but not every terminal implements it — macOS
// Terminal.app ignores both, and the title is left showing a countdown that
// finished. So we keep the title ourselves instead: Claude sets it with an OSC
// sequence, and every byte it writes passes through us on the way to the
// terminal, so we can read the title off that stream and write it back verbatim.
// Only OSC 0 (icon + title) and OSC 2 (title) carry one; both end in BEL or ST.
const oscTitleRegex: RegExp = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// A sequence can be split across two pty chunks, so an unfinished one is carried
// into the next scan. Capped, so an introducer that never gets its terminator
// can't grow the carry without bound.
const TITLE_CARRY_MAX: number = 4096;

let childTitle: string = '';          // the last title Claude set ('' until it sets one)
let titleCarry: string = '';          // partial sequence carried between chunks
let titleOverridden: boolean = false; // the countdown is currently showing its own title

// Scan a chunk of Claude's output for title sequences, keeping the last one.
function trackTitle(data: string): void {
    const stream: string = titleCarry + data;
    let consumed: number = 0;
    let match: RegExpExecArray | null;
    oscTitleRegex.lastIndex = 0;
    while ((match = oscTitleRegex.exec(stream)) !== null) {
        childTitle = match[1]!;
        consumed = oscTitleRegex.lastIndex;
    }
    titleCarry = pendingOsc(stream.slice(consumed));
    if (titleCarry.length > TITLE_CARRY_MAX) titleCarry = '';
    // Claude just took the title for itself; put our suffix back on top. Our
    // own setTitle writes go to the real terminal only, never into the pty, so
    // this can't loop.
    if (consumed > 0) renderTitle();
}

// The part of a chunk that may be an OSC sequence still waiting for the rest of
// itself: from the last *unterminated* ESC ] onwards, or a lone trailing ESC
// that could become one. Note it can't just be "from the last ESC" — the ESC of
// an ST terminator sits inside the very sequence we're trying to keep.
// An OSC that's already terminated is one we didn't want (OSC 8, OSC 10, …), so
// it's dropped rather than carried, which is what keeps the carry from growing.
function pendingOsc(rest: string): string {
    const start: number = rest.lastIndexOf('\x1b]');
    if (start !== -1) {
        const tail: string = rest.slice(start);
        const terminated: boolean = tail.includes('\x07') || tail.indexOf('\x1b\\', 1) !== -1;
        if (!terminated) return tail;
    }
    return rest.endsWith('\x1b') ? '\x1b' : '';
}

function setTitle(title: string): void {
    try {
        process.stdout.write(`\x1b]0;${title}\x07`);
    } catch { /* terminal already gone */ }
}

// Put back the title Claude last set — composed with the quota suffix, so the
// suffix survives a countdown taking the title and handing it back. If Claude
// never set a title, the suffix (or nothing) stands alone. No-op unless the
// countdown took the title over.
function restoreTitle(): void {
    if (!titleOverridden) return;
    titleOverridden = false;
    setTitle(composeTitle());
}

// The quota leg of the title bar, e.g. "GLM 5h 82% →2h 48m": current spend of
// the 5-hour window and how long until the window's next shift (the moment the
// oldest tokens in it age out — during a limit wait, that *is* the resume
// time). " ⚠" appears from QUOTA_WARN_PCT, "?" when the reading predates a
// failed poll, " · MCP 91%" when the monthly allowance is nearly gone. Empty
// until the first reading — Claude's title then stands alone.
function quotaSuffix(): string {
    const snap: QuotaSnapshot | null = lastQuota;
    if (snap === null || snap.tokens === null) return '';
    const tokens: QuotaWindow = snap.tokens;

    let suffix: string = `GLM 5h ${Math.round(tokens.percentage)}%`;
    if (tokens.percentage >= QUOTA_WARN_PCT) suffix += ' ⚠';
    if (tokens.nextResetTime !== null) {
        suffix += ` →${formatDuration(tokens.nextResetTime - Date.now())}`;
    }
    if (quotaStale) suffix += '?';
    if (snap.monthly !== null && snap.monthly.percentage >= MCP_WARN_PCT) {
        suffix += ` · MCP ${Math.round(snap.monthly.percentage)}%`;
    }
    return suffix;
}

// Claude's own title plus the quota suffix. Composed from the raw childTitle
// every time — never from the last composed string — so rewrites can't stack
// suffixes.
function composeTitle(): string {
    const suffix: string = quotaSuffix();
    if (suffix === '') return childTitle;
    return childTitle === '' ? suffix : `${childTitle} · ${suffix}`;
}

// The single writer of the title outside a countdown. While a countdown runs
// it owns the title (titleOverridden, rewritten every second), so this stays
// out of its way; every other change — Claude setting a title, a fresh
// reading, a stale mark — lands through here, which is also what reasserts
// the suffix right after one of Claude's own title writes.
function renderTitle(): void {
    if (titleOverridden) return;
    setTitle(composeTitle());
}

// ==========================================
// QUOTA POLLING
// ==========================================
// A standing poll keeps the title bar current and — once P4 wires it in —
// gives a running limit wait its early-resume signal. It's fire-and-forget:
// nothing in the wrapper ever waits on it, and it dies with the session.
// Failed polls back off exponentially and mark the last reading stale ("?" in
// the title) rather than dropping it — a questioned reading beats none.
const glmCredentials: GlmCredentials | null = resolveGlmCredentials();

let quotaPollTimer: NodeJS.Timeout | null = null;
let quotaBackoffMs: number = QUOTA_POLL_INTERVAL_MS;
let lastQuota: QuotaSnapshot | null = null;
let quotaStale: boolean = false; // the last reading predates a failed poll

function startQuotaPolling(): void {
    if (glmCredentials === null) {
        log('quota polling off: no GLM credentials found');
        return;
    }
    void pollQuota(); // first reading immediately, the next one scheduled off it
}

function stopQuotaPolling(): void {
    if (quotaPollTimer !== null) {
        clearTimeout(quotaPollTimer);
        quotaPollTimer = null;
    }
}

// setTimeout-chained rather than setInterval: a poll that runs long or a
// backed-off gap can never stack a second request on top of a pending one.
function scheduleNextPoll(delayMs: number): void {
    stopQuotaPolling();
    quotaPollTimer = setTimeout(() => { void pollQuota(); }, delayMs);
}

async function pollQuota(): Promise<void> {
    const snap: QuotaSnapshot | null =
        glmCredentials === null ? null : await fetchQuotaSnapshot(glmCredentials);

    if (snap === null) {
        if (lastQuota !== null) quotaStale = true;
        quotaBackoffMs = Math.min(quotaBackoffMs * 2, QUOTA_BACKOFF_MAX_MS);
        log(`quota poll failed — next attempt in ${Math.round(quotaBackoffMs / 60000)} min`);
        renderTitle();
        scheduleNextPoll(quotaBackoffMs);
        return;
    }

    quotaBackoffMs = QUOTA_POLL_INTERVAL_MS;
    quotaStale = false;
    lastQuota = snap;
    const tokens: QuotaWindow | null = snap.tokens;
    if (tokens !== null) {
        const monthly: string = snap.monthly !== null ? `, MCP ${snap.monthly.percentage}%` : '';
        log(`quota: 5h ${tokens.percentage}%${monthly}` +
            (tokens.nextResetTime === null
                ? ''
                : `, resets ${new Date(tokens.nextResetTime).toLocaleTimeString()}`));
        if (tokens.percentage >= QUOTA_WARN_PCT) {
            log(`5-hour window at ${tokens.percentage}% — closing on the limit`);
        }
        considerEarlyResume(tokens);
    }
    renderTitle();
    scheduleNextPoll(QUOTA_POLL_INTERVAL_MS);
}

// ==========================================
// FIRST-RUN TRUST DIALOG
// ==========================================
// Claude's first-run "trust this folder?" prompt is drawn on the MAIN screen,
// before Claude switches to the alternate screen for its TUI. Normally the alt
// screen restores the main buffer on exit — that's how the shell prompt comes
// back exactly where it was — but here the main buffer still holds the trust
// dialog, and the cursor is restored into the middle of it, so the returning
// prompt prints across the leftover lines instead of on a clean screen.
//
// We can't stop Claude drawing the dialog, but if we saw it go by we know the
// restored main screen is dirty, so cleanup() clears it rather than handing back
// a wall of stale onboarding text. We only scan up to the first alternate-screen
// switch: the dialog is always drawn before it, and after it any "trust this
// folder" wording is just chat content on the alt buffer, which never leaks out.
const ONBOARDING_MARKERS: readonly string[] = ['trust this folder', 'Quick safety check'];
const ALT_SCREEN_ENTER: string = '\x1b[?1049h';
// Longer than any marker, so a marker split across two pty chunks is still whole
// once the previous chunk's tail is prepended.
const ONBOARDING_CARRY_MAX: number = 64;
// Home, clear screen, clear scrollback — sent on exit only when the dialog was
// seen, to wipe the leftover the alt-screen restore would otherwise bring back.
const ONBOARDING_CLEAR: string = '\x1b[H\x1b[2J\x1b[3J';

let onboardingSeen: boolean = false;   // the trust dialog was drawn this session
let altScreenEntered: boolean = false; // scanning stops once the TUI takes over
let onboardingCarry: string = '';      // partial marker carried between chunks

function trackOnboarding(data: string): void {
    if (altScreenEntered || onboardingSeen) return;
    const haystack: string = onboardingCarry + data;
    if (ONBOARDING_MARKERS.some(marker => haystack.includes(marker))) {
        onboardingSeen = true;
        onboardingCarry = '';
        log('First-run trust dialog seen — main screen will be cleared on exit');
        return;
    }
    // Once the alt screen is entered the dialog is behind us; stop scanning so
    // later chat that mentions trusting a folder can't trip the exit clear.
    if (haystack.includes(ALT_SCREEN_ENTER)) {
        altScreenEntered = true;
        onboardingCarry = '';
        return;
    }
    onboardingCarry = haystack.slice(-ONBOARDING_CARRY_MAX);
}

// ==========================================
// I/O WIRING
// ==========================================
process.stdout.on('resize', () => {
    const c: number = process.stdout.columns || cols;
    const r: number = process.stdout.rows || rows;
    ptyProcess.resize(c, r);
    term.resize(c, r);
});

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
process.stdin.resume();

// Forward everything the user types straight to Claude, with one rule while
// an auto-resume is pending: any key means the user is driving now — the
// pending wait is cancelled so our Ctrl-U+continue can never wipe a draft
// they're typing. F4 (swallowed, never forwarded) does the same on purpose.
process.stdin.on('data', (data: string) => {
    if (isWaiting && F4_SEQUENCES.some(seq => data.includes(seq))) {
        let rest = data;
        for (const seq of F4_SEQUENCES) rest = rest.split(seq).join('');
        cancelAllWaits('F4');
        if (rest.length > 0) ptyProcess.write(rest);
        return;
    }
    if (isAutoResumePending()) cancelAllWaits('user input');
    ptyProcess.write(data);
});

// Forward Claude's output to the real terminal and mirror it into the headless
// terminal so its screen buffer stays in sync with what's on screen.
ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    term.write(data);
    trackTitle(data);
    trackOnboarding(data);
});

// ==========================================
// SCREEN CAPTURE
// ==========================================
// Read the current visible screen out of the headless terminal's buffer: the
// `rows` lines starting at baseY (the top of the bottommost page).
function captureScreen(): string {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row++) {
        const line = buffer.getLine(buffer.baseY + row);
        lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// CLEANUP / TEARDOWN
// ==========================================
// A TUI switches the terminal into modes a plain shell never uses: mouse
// reporting, bracketed paste, a hidden cursor, a shrunk scroll region, the
// alternate screen. Claude undoes its own when it shuts down cleanly, but a
// killed session (or one whose final bytes we cut off) leaves them set, and the
// shell inherits them — a stray mouse move then prints things like "[<35;1;1M".
// So we put the terminal back ourselves. Every one of these is a no-op if the
// mode was already off, which makes it safe to send unconditionally.
//
// Two of them move the cursor as a side effect, though, and would leave it at
// the top of the window instead of on the line your prompt should return to:
// resetting the scroll region homes the cursor, and leaving the alternate
// screen restores the cursor saved when it was *entered* — stale, since Claude
// has normally left the alt screen already by the time we get here. So the whole
// block is bracketed in DECSC/DECRC (ESC 7 / ESC 8), which puts the cursor back
// where the exiting session left it. DECRC also restores the attributes DECSC
// saved, so the SGR reset has to come after it, not inside.
const TERMINAL_RESET: string =
    '\x1b7' +                                                    // save cursor (position + attrs)
    '\x1b[?1049l' +                                              // leave the alternate screen
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' +  // all mouse reporting off
    '\x1b[?2004l' +                                              // bracketed paste off
    '\x1b[?7h' +                                                 // autowrap back on
    '\x1b[?25h' +                                                // cursor visible again
    '\x1b[r' +                                                   // scroll region = whole window
    '\x1b8' +                                                    // and put the cursor back
    '\x1b[0m';                                                   // drop leftover colours/attrs

// How long we let stdout drain before giving up and exiting anyway.
const FLUSH_TIMEOUT_MS: number = 500;

let cleanedUp = false;
function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    resumeEpoch++; // retire any in-flight query or callback
    if (transientTimer) {
        clearTimeout(transientTimer);
        transientTimer = null;
    }
    if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
    }
    stopQuotaPolling();
    restoreTitle();
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* terminal already gone */ }
    process.stdin.pause();
    // From here on the pty is gone, so the screen is finally ours to write to.
    // If the first-run trust dialog was shown, the alt-screen restore has just
    // brought its stale lines back onto the main screen; clear them so the shell
    // prompt returns to a clean screen instead of mid-dialog.
    const resetSeq: string = onboardingSeen ? TERMINAL_RESET + ONBOARDING_CLEAR : TERMINAL_RESET;
    try { process.stdout.write(resetSeq); } catch { /* terminal already gone */ }
}

// process.exit() drops anything still queued on stdout, and on Windows a TTY
// stdout is *asynchronous* — so exiting the instant the pty dies truncates the
// tail of Claude's output mid-escape-sequence and leaves the wreckage on screen.
// Wait for the queue to flush first. The timeout is the backstop for a terminal
// that has stopped draining (closed window, dead ssh link), which must not hang us.
function exitAfterFlush(code: number): void {
    let exited: boolean = false;
    const done = (): void => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        process.exit(code);
    };
    const timer: NodeJS.Timeout = setTimeout(done, FLUSH_TIMEOUT_MS);
    // An empty write's callback fires once everything queued ahead of it is out.
    process.stdout.write('', () => done());
}

process.on('exit', cleanup);
// In raw mode Ctrl-C is forwarded to Claude as \x03, so these handlers only fire
// for out-of-band signals — they won't swallow the user's Ctrl-C.
process.on('SIGINT', () => { cleanup(); exitAfterFlush(0); });
process.on('SIGTERM', () => { cleanup(); exitAfterFlush(0); });

ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    cleanup();
    exitAfterFlush(exitCode);
});

// ==========================================
// MAIN PROCESS
// ==========================================

function main(): void {
    log('===== START =====');
    log(`Forwarding to claude: ${forwardedArgs.join(' ')}`);
    startQuotaPolling();
    // Capture the screen state every x seconds
    captureInterval = setInterval(() => {
        // Already handling a limit (waiting it out or mid-verification) — do nothing.
        if (isWaiting || isVerifying || isHandlingMenu) return;
        currentScreen = captureScreen();
        onScreenCapture();
    }, SCREEN_CAPTURE_INTERVAL_MS);
}
main();

function onScreenCapture(): void {
    logScreen();
    // Ticks only count toward the transient-ladder reset when error handling
    // is actually live: ticks skipped by a wait, menu or send grace can't age
    // a failure out, and neither can the send-grace window itself.
    if (!isAutoResumePending() && !isVerifying && !isHandlingMenu && Date.now() >= resumeSentGraceUntil) {
        cleanCaptureTicks++;
        if (transientTier > 0 && cleanCaptureTicks >= TRANSIENT_RESET_TICKS) {
            transientTier = 0;
            lastResumeWasEarly = false; // a bounced early resume is old news by now
            log('10 minutes clean — transient retry ladder reset');
        }
    }
    detectLimit(currentScreen);
}

function logScreen(screen: string = currentScreen, msg: string = "SCREEN"): void {
    log(msg +
      '\n##################################################' +
      '\n' + screen +
      '\n##################################################');
}

// ==========================================
// LIMIT DETECTION
// ==========================================

// The newest match of `pattern` on screen and where it starts, or null if
// there's none. We take the last one because a premature reset can leave the old
// banner and a fresh one on screen at once, and it's the newest that says
// whether we're still limited — the same holds for repeated API errors.
function lastMatch(screen: string, pattern: RegExp): { index: number; match: RegExpMatchArray } | null {
    const re: RegExp = new RegExp(pattern.source, 'gi');
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(screen)) !== null) last = m;
    return last === null ? null : { index: last.index, match: last };
}


// True when something we sent to get a stopped session moving again — the
// "continue" from a resume — sits below `index`, i.e. we have already dealt
// with whatever we matched there, so it's stale scrollback.
// See HANDLED_STOP_MARKERS: a genuinely live error renders below the last of
// them, so nothing follows it and it still gets handled.
function alreadyHandledPast(screen: string, index: number): boolean {
    const below: string = screen.slice(index);
    return HANDLED_STOP_MARKERS.some(marker => below.includes(marker));
}


// True while Claude's resume-from-summary question is on screen. Answering it is
// the user's call, so we send nothing — no quota query, no resume.
function hasResumePrompt(screen: string): boolean {
    return screen.toLowerCase().includes(RESUME_PROMPT_TEXT);
}

function detectLimit(screen: string): void {
    // Already handling a limit (waiting it out or mid-verification) — do nothing.
    if (isWaiting || isVerifying || isHandlingMenu) return;

    // Scrolled-up history is stale; ignore it.
    if (screen.includes(SCROLL_INDICATOR)) return;

    // Checked before the menu below, which would answer this question with its Enter.
    if (hasResumePrompt(screen)) {
        log('Resume-from-summary question on screen — detection paused');
        return;
    }

    // Auto-select Claude's "Stop and wait for limit to reset" menu when shown.
    // While the menu is on screen we never run error detection (it would type
    // into the menu), so handle it here and bail out.
    if (screen.toLowerCase().includes(MENU_PROMPT_TEXT)) {
        isHandlingMenu = true;
        log('Menu detected — selecting "Stop and wait for limit to reset"');
        setTimeout(() => {
            ptyProcess.write('\r');
            // Release after a grace period so a genuinely new menu can still
            // be handled later, but the redraw of this one can't re-trigger.
            setTimeout(() => { isHandlingMenu = false; }, MENU_GRACE_MS);
        }, MENU_ENTER_DELAY_MS);
        return;
    }

    // The only stop signal left: an API error line. Whether it's quota (GLM's
    // 5-hour window) or something transient is decided inside.
    handleApiError(screen);
}

// ==========================================
// ERROR → RESUME MACHINERY
// ==========================================
// Every stop is an "● API Error:" line. The flow: classify (limit-shaped vs
// transient), then either wait out a deadline or climb the transient ladder,
// then send "continue" through one outlet. Recovery sources — a deadline
// firing, an early-resume poll, a transient timer, a probe — all funnel into
// trySendResume(), and a generation counter (resumeEpoch) retires results
// that arrive after their wait was cancelled (F4, user takeover, exit).

// How much of the error line to scan: the message can wrap across narrow
// widths, so classification reads a window from the match, not one line.
const ERROR_TAIL_CHARS: number = 240;

let resumeEpoch: number = 0;           // bumped on cancel/exit; retires stale async work
let quotaApiRetryUntil: number = 0;    // no error-triggered API query before this
let resumeSentGraceUntil: number = 0;  // a resume just went out; let its echo land
let transientTimer: NodeJS.Timeout | null = null;
let transientTier: number = 0;         // rung on TRANSIENT_DELAYS_MS (0 = first failure)
let cleanCaptureTicks: number = 0;     // consecutive captures with no new error event
let probeTimer: NodeJS.Timeout | null = null;
let limitDeadline: number | null = null; // epoch ms; null = probing without one
let waitStartedAt: number = 0;
let limitWaitMonthly: boolean = false; // the wait is for the monthly allowance
let windowHighSeen: boolean = false;   // the window verifiably read spent (or 1308 said so)
let lowStreak: number = 0;             // consecutive polls reading below the confirm line
let earlyResumeDisabledUntil: number = 0; // an early resume bounced: deadlines only
let lastResumeWasEarly: boolean = false;

function isAutoResumePending(): boolean {
    return isWaiting || transientTimer !== null || probeTimer !== null;
}

// Tear down an in-progress limit wait (countdown or probe loop), restoring
// detection and the title. The epoch bump retires this wait's in-flight
// queries and callbacks.
function endLimitWait(): void {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
    }
    if (isWaiting) resumeEpoch++;
    isWaiting = false;
    limitDeadline = null;
    restoreTitle(); // no-op unless the wait had taken the title
}

// F4, or any user keystroke while something is pending: the user is driving
// now. Cancels every pending auto-resume — limit wait, transient timer,
// probe — and re-arms detection so the same error can be acted on afresh.
function cancelAllWaits(reason: string): void {
    resumeEpoch++;
    endLimitWait();
    if (transientTimer) {
        clearTimeout(transientTimer);
        transientTimer = null;
    }
    log(`Auto-resume cancelled (${reason}) — detection re-armed`);
}

// The single place a "continue" goes out. Returns false — without sending —
// when Claude can't take input right now (resume question, wait-for-reset
// menu, its own retry backoff), so the caller's own tick tries again: that's
// why a countdown keeps ticking past its deadline while a hold is up.
// Sending is: clear the composer, type "continue", Enter. The echo that
// follows is what retires the error we acted on (see RESUME_CONTINUE_MARKER).
function trySendResume(reason: string): boolean {
    if (Date.now() < resumeSentGraceUntil) return false;

    const screen: string = captureScreen();
    if (hasResumePrompt(screen)) {
        log(`Resume due (${reason}) but the resume-from-summary question is up — holding`);
        return false;
    }
    if (screen.toLowerCase().includes(MENU_PROMPT_TEXT)) {
        log(`Resume due (${reason}) but the wait-for-reset menu is up — holding`);
        return false;
    }
    if (RETRY_HINT_REGEX.test(screen)) {
        log(`Resume due (${reason}) but Claude is retrying on its own — holding`);
        return false;
    }

    if (isWaiting) endLimitWait();
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + RESUME_CONTINUE_TEXT + '\r');
    resumeSentGraceUntil = Date.now() + SEND_GRACE_MS;
    log(`Sending "${RESUME_CONTINUE_TEXT}" (${reason})`);
    return true;
}

// The reset time inside a limit message, as local-time epoch ms, or null.
function parseBannerResetTime(tail: string): number | null {
    const m: RegExpMatchArray | null = tail.match(BANNER_RESET_TIME_REGEX);
    if (m === null) return null;
    const t: number = new Date(
        parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
        parseInt(m[4]!, 10), parseInt(m[5]!, 10), parseInt(m[6]!, 10),
    ).getTime();
    return Number.isNaN(t) ? null : t;
}

// A 529 or any other non-limit failure: nothing to confirm against and
// nothing to wait for — the ladder paces the retries.
function scheduleTransientRetry(tail: string): void {
    const delay: number = TRANSIENT_DELAYS_MS[transientTier]!;
    transientTier = Math.min(transientTier + 1, TRANSIENT_DELAYS_MS.length - 1);
    const gist: string = tail.replace(/\s+/g, ' ').slice(0, 80);
    log(`Transient API error ("${gist}") — continuing in ${Math.round(delay / 1000)}s`);
    transientTimer = setTimeout(() => {
        transientTimer = null;
        trySendResume('transient');
    }, delay);
}

// Enter a limit wait. A known deadline counts down to it; a missing one runs
// a probe loop instead — bounded, never a silent hang. The floor is applied
// once, here: a deadline already in the past (clock skew, a window that
// shifted while we queried) still leaves MIN_WAIT_MS before the resume, and
// later information replaces the deadline rather than re-flooring it.
function startLimitWait(deadline: number | null, monthly: boolean): void {
    const now: number = Date.now();
    if (deadline !== null && deadline < now + MIN_WAIT_MS) deadline = now + MIN_WAIT_MS;

    limitDeadline = deadline;
    waitStartedAt = now;
    limitWaitMonthly = monthly;
    lowStreak = 0;
    windowHighSeen = true; // the banner itself: this request was throttled

    isWaiting = true;
    titleOverridden = true;

    if (deadline !== null) {
        log(`Limit wait until ${new Date(deadline).toLocaleString()}` +
            (monthly ? ' (monthly allowance)' : ' (5-hour window)'));
        startCountdownTicks();
        return;
    }
    log('Limit-shaped error with no usable reset time — probing for one');
    scheduleProbe();
}

function startCountdownTicks(): void {
    countdownInterval = setInterval(() => {
        const remainingMs: number = (limitDeadline ?? 0) - Date.now();

        if (remainingMs > 0) {
            const totalSeconds: number = Math.floor(remainingMs / 1000);
            const h: number = Math.floor(totalSeconds / 3600);
            const m: number = Math.floor((totalSeconds % 3600) / 60);
            const s: number = totalSeconds % 60;
            const timeStr: string = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
            setTitle(`⏳ GLM resumes: ${timeStr}`);
            return;
        }

        // Due. A hold (question, menu, Claude retrying) returns false and the
        // next tick tries again; a real send tears the wait down on its own.
        if (trySendResume('deadline') && countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }, 1000);
}

// No deadline: every PROBE_INTERVAL_MS, re-query for a reset time (an upgrade
// to a real countdown) and send one probing "continue". If the quota API is
// down too, the probe still goes out alone — a transient error heals on it,
// and a true limit can only fail it.
function scheduleProbe(): void {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
        probeTimer = null;
        if (!isWaiting) return;
        const myEpoch: number = resumeEpoch;
        void (async (): Promise<void> => {
            if (glmCredentials !== null) {
                const snap: QuotaSnapshot | null = await fetchQuotaSnapshot(glmCredentials);
                if (resumeEpoch !== myEpoch) return;
                const window: QuotaWindow | null = snap?.tokens ?? null;
                if (window !== null && window.nextResetTime !== null) {
                    let deadline: number = window.nextResetTime + WAIT_BUFFER_MS;
                    if (deadline < Date.now() + MIN_WAIT_MS) deadline = Date.now() + MIN_WAIT_MS;
                    log(`Probe found a reset time — counting down to ${new Date(deadline).toLocaleTimeString()}`);
                    limitDeadline = deadline;
                    if (probeTimer !== null) {
                        clearTimeout(probeTimer);
                        probeTimer = null;
                    }
                    startCountdownTicks();
                    return;
                }
            }
            if (resumeEpoch !== myEpoch || !isWaiting) return;
            trySendResume('probe');
            if (isWaiting) scheduleProbe(); // a held send tries again next round
        })();
    }, PROBE_INTERVAL_MS);
}

// A fresh reading arrived while a limit wait runs. The 5-hour window reading
// back below the confirm line — twice, if no spent reading was ever seen —
// means capacity is back (old tokens aged out ahead of the deadline); resume
// now rather than waiting the clock out. Monthly waits ignore this: their
// window is the monthly one, and the 5-hour reading says nothing about it.
function considerEarlyResume(tokens: QuotaWindow): void {
    if (!isWaiting || limitWaitMonthly) return;
    if (Date.now() < earlyResumeDisabledUntil) return;
    if (Date.now() - waitStartedAt < MIN_WAIT_MS) return;

    if (tokens.percentage >= LIMIT_CONFIRM_PCT) {
        windowHighSeen = true;
        lowStreak = 0;
        return;
    }
    lowStreak++;
    if (lowStreak < (windowHighSeen ? 1 : 2)) return;

    log(`5-hour window back down to ${tokens.percentage}% — resuming early`);
    if (trySendResume('quota-early')) {
        lastResumeWasEarly = true;
    }
}

// Classify a live API error and start the right kind of wait. Screen evidence
// leads: a limit-shaped banner puts us in a limit wait whatever the quota API
// says, and a non-limit banner climbs the transient ladder however full the
// window reads. Inside a limit wait the quota API's job is only to supply the
// precise deadline and, later, the early-resume signal.
function handleApiError(screen: string): void {
    const error = lastMatch(screen, apiErrorRegex);
    if (error === null) return;

    if (alreadyHandledPast(screen, error.index)) {
        log('API error sits above a resume we already sent — ignoring as stale');
        return;
    }
    // A pending wait/timer owns this error already, and a just-sent resume is
    // waiting for its echo — neither needs a second claim.
    if (isAutoResumePending() || Date.now() < resumeSentGraceUntil) return;

    cleanCaptureTicks = 0; // a new error event ends any clean run
    const tail: string = screen.slice(error.index, error.index + ERROR_TAIL_CHARS);
    const isLimit: boolean = LIMIT_ERROR_PATTERNS.some(re => re.test(tail));

    if (!isLimit) {
        scheduleTransientRetry(tail);
        return;
    }

    // Limit-shaped: resolve the best deadline — quota API first (precise; the
    // monthly window if the message names it), then the banner's own time,
    // then none (probe loop).
    isVerifying = true;
    const myEpoch: number = resumeEpoch;
    void (async (): Promise<void> => {
        try {
            const monthly: boolean = MONTHLY_LIMIT_PATTERN.test(tail);
            let deadline: number | null = null;

            if (glmCredentials !== null && Date.now() >= quotaApiRetryUntil) {
                const snap: QuotaSnapshot | null = await fetchQuotaSnapshot(glmCredentials);
                if (resumeEpoch !== myEpoch) return;
                if (snap === null) {
                    quotaApiRetryUntil = Date.now() + QUOTA_RETRY_AFTER_FAIL_MS;
                    log('quota API unusable while confirming a limit — falling back');
                } else {
                    const window: QuotaWindow | null = monthly ? snap.monthly : snap.tokens;
                    if (window !== null && window.nextResetTime !== null) {
                        deadline = window.nextResetTime + WAIT_BUFFER_MS;
                    }
                }
            }
            if (resumeEpoch !== myEpoch) return;
            if (deadline === null) {
                const bannerTime: number | null = parseBannerResetTime(tail);
                if (bannerTime !== null) deadline = bannerTime + WAIT_BUFFER_MS;
            }

            // An early resume that bounced straight back means the window
            // wasn't really clear: this wait trusts only its hard deadline.
            if (lastResumeWasEarly) {
                lastResumeWasEarly = false;
                earlyResumeDisabledUntil = deadline ?? (Date.now() + EARLY_RESUME_FALLBACK_MS);
                log(`Early resume bounced — early resume off until ${new Date(earlyResumeDisabledUntil).toLocaleTimeString()}`);
            }

            startLimitWait(deadline, monthly);
        } finally {
            isVerifying = false;
        }
    })();
}

