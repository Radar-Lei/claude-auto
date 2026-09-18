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
const WRAPPER_FLAGS: ReadonlySet<string> = new Set(['--auto-debug', AUTO_MODE_OFF_FLAG]);

// Debug logging is opt-in via a flag (no env var). Pass --auto-debug.
const DEBUG: boolean = process.argv.includes('--auto-debug');

// Everything after `node claude-glm-auto.ts`, minus our own flags.
const cliArgs: string[] = process.argv.slice(2).filter(arg => !WRAPPER_FLAGS.has(arg));

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

// Every phrase that means "out of quota — wait for the reset". They're aliases:
// whichever matches, the handling is identical (same guards, same /usage
// confirmation, same countdown), so adding a wording is a one-line change here.
//
// Rules for a new entry:
//   * Anchor on the "you've hit it" wording, never on a percentage — Claude
//     shows early warnings ("90% of your limit used") that must not trip this.
//   * A reset clock time may be captured in groups 1–3 (hours, optional minutes,
//     am/pm), but it's optional: the countdown always uses the time /usage
//     reports, and the banner's own time only tells two banners apart (see
//     DISPROVED_LIMIT_WINDOW_MS). Patterns without one work fine.
//   * Match against the *rendered* screen, so keep whitespace lenient — a line
//     can be re-wrapped at narrow widths — and expect no colour codes.
const LIMIT_PATTERNS: RegExp[] = [
    // "⎿  You've hit your monthly spend limit." — the spend cap on extra usage.
    // No reset time in the line, so /usage supplies it: see USAGE_CONFIRM_PCT.
    /⎿\s+ *you've\s+hit\s+your\s+monthly\s+spend\s+limit/i,
    // "⎿  You've hit your weekly limit ∙ resets Jul 22, 8am". The reset clause
    // is optional here, unlike the session one below: a weekly reset is days out,
    // so it prints a date, which the clock-time groups can't match — requiring
    // them would mean never matching this banner at all. /usage times the wait.
    /⎿\s+ *you've\s+hit\s+your\s+weekly\s+limit(?:[\s\S]{0,80}?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i,
    // "⎿  You've hit your session limit ∙ resets 11:50am". Time is lenient:
    // optional minutes, optional space, any case am/pm.
    /⎿\s+ *you've\s+hit\s+your\s+session\s+limit[\s\S]{0,80}?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
];

// Claude no longer always runs a session into its hard limit. Near the top of the
// window it stops on its own and writes a checkpoint line instead — "● Checkpoint
// created …" — and the same shape carries the "● Claude usage limit reached" wording.
// Either way the session is parked until something sends "continue", so these are
// handled exactly like a limit banner: same guards, same /usage confirmation, same
// countdown. The one difference is the bar reading that confirms them, because a
// checkpoint fires *before* the session is spent (see CHECKPOINT_CONFIRM_PCT).
//
// Rules for a new entry: it's matched against a line that starts with the assistant
// bullet, and the phrase has to sit on that same line — so "checkpoint" written
// anywhere in Claude's own prose can't trip this. Keep entries lowercase (matching
// is case-insensitive) and plain: they're spliced into a regex, with the spaces
// between words made lenient so a re-render can't break a match.
const CHECKPOINT_PHRASES: string[] = [
    'checkpoint',
    'usage limit',
];

// The bullet has to open the line and the phrase has to sit on it: (?:^|\n) is
// the line start (a /m anchor wouldn't survive lastMatch recompiling the pattern
// with flags of its own), and every gap after it is horizontal whitespace or
// "anything but a newline", so a match can never run across two lines.
const CHECKPOINT_PATTERNS: RegExp[] = CHECKPOINT_PHRASES.map(phrase => new RegExp(
    '(?:^|\n)[ \t]*●[^\n]*?' + phrase.split(/\s+/).join('[ \t]+'), 'i'));

// A checkpoint is Claude stopping *near* the top of the window rather than at it,
// so the 100% rule that confirms a limit banner would never fire for one. The
// session bar has to read at least this much before we count down; below it the
// line is written off as stale, exactly like a disproved banner.
//
// Only the session bar is judged by this threshold — the weekly bar keeps
// USAGE_CONFIRM_PCT. A week sitting at 96% still runs sessions fine and resets
// days out, so counting down to it on a checkpoint would park the wrapper for
// days over a limit that isn't blocking anything.
const CHECKPOINT_CONFIRM_PCT: number = 95;

// A transient upstream failure, rendered into the transcript as "● API Error: 529"
// (overloaded). Nothing about it is quota, so there's nothing /usage could
// confirm — it clears on its own. All we do is wait a short while and retry.
// Whitespace is loose because the line can be re-wrapped at narrow widths.
const apiErrorRegex: RegExp = /●\s*API Error:/i;

// How long to sit out a 529 before sending "continue" again.
const API_ERROR_COOLDOWN_MS: number = 5 * 60 * 1000;

// Claude sometimes offers a "Stop and wait for limit to reset" menu; we select it
// (press Enter) so the session parks until reset. Wait briefly so the menu has
// fully rendered, then ignore it for a grace period so the redraw doesn't make
// us press Enter twice.
const MENU_PROMPT_TEXT: string = '❯ stop and wait for limit to reset';
const MENU_ENTER_DELAY_MS: number = 2000;
const MENU_GRACE_MS: number = 5000;

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

// A candidate limit is verified through the /usage panel instead of a chat
// probe: we open it, read the bars for the limits that can block a session
// (percent used + reset time), and close it again. The reset times shown there
// are authoritative — banner times are rounded and the banner itself can be stale.
const USAGE_COMMAND: string = '/usage';
// Pause between typing a slash command and pressing Enter, so the autocomplete
// has settled on it before we submit it — /usage here, /low-priority below.
const SLASH_MENU_SETTLE_MS: number = 500;
// Pause after Enter before the first read, so the panel has rendered.
const USAGE_RENDER_DELAY_MS: number = 1500;

// The panel is a stack of sections, each a heading followed by "███ 54% used"
// and usually a "Resets …" line. Two of them are limits we can wait out; the
// others are listed only as terminators, so that a percentage is never read
// against the wrong limit:
//
//   Current session            the rolling session window — "Resets 11:50am"
//   Current week (all models)  the plan's weekly quota — "Resets Jul 22, 8am"
//   Current week (Opus)        Opus only: Claude Code drops to Sonnet rather
//                              than stopping, so it never blocks a session
//   What's contributing …      trailing prose, no limit of its own
//
// Order matters: "(all models)" is tried before the bare "current week", or the
// Opus row would be taken for the plan quota. See findHeadings.
type UsageSection = 'session' | 'weekly' | 'other';

const USAGE_HEADINGS: { section: UsageSection; pattern: RegExp }[] = [
    { section: 'session', pattern: /current\s+session/i },
    { section: 'weekly', pattern: /current\s+week\s*\(\s*all\s+models\s*\)/i },
    { section: 'other', pattern: /current\s+week/i },
    { section: 'other', pattern: /what.s\s+contributing/i },
];

// "███ 54% used", plus the two shapes a reset line takes. The session prints a
// clock time ("Resets 11:50am (Europe/Berlin)"); the weekly rows are days out so
// they print a date as well ("Resets Jul 22, 8am (Europe/Berlin)"). Neither
// regex can match the other's line — one needs a digit after "resets", the other
// a month name — so a leaky region can't cross the two.
const usagePercentRegex: RegExp = /(\d{1,3})\s*%\s*used/i;
const usageResetRegex: RegExp = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const usageWeeklyResetRegex: RegExp = /resets\s+([a-z]{3,9})\s+(\d{1,2})\s*,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const MONTH_ABBREVIATIONS: string[] =
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The weekly reset line carries no year. Reading one slightly in the past is
// normal — the panel is a snapshot — but a date months behind us is next year's,
// which happens for one week every New Year.
const USAGE_WEEKLY_BACKDATE_MS: number = 24 * 60 * 60 * 1000;

// A bar confirms its limit only when it reads 100% used; anything less means the
// banner that triggered us was stale. The same threshold serves both bars, and
// either one at 100% blocks the session on its own — so a banner is stale only
// when *neither* is spent.
//
// Between them they cover every phrase in LIMIT_PATTERNS, including "you've hit
// your monthly spend limit", which names neither. Extra usage is only ever spent
// once the included plan quota is gone, so that banner can't appear while both
// bars are still climbing: by then one of them reads 100%, and waiting for it to
// come back is exactly what puts us back on plan quota.
//
// Checkpoints are the exception: they appear before the session is spent, so the
// session bar is judged against CHECKPOINT_CONFIRM_PCT for those. The weekly bar
// is held to this threshold either way.
const USAGE_CONFIRM_PCT: number = 100;

// When the window is too small to show the whole block at once, we scroll the
// panel one step at a time (down arrow) and re-read, up to this many steps.
const USAGE_SCROLL_KEY: string = '\x1b[B';
const USAGE_SCROLL_DELAY_MS: number = 300;
const USAGE_MAX_SCROLL_STEPS: number = 40;

// Esc closes the panel; give the main screen a moment to redraw afterwards.
const USAGE_CLOSE_KEY: string = '\x1b';
const USAGE_CLOSE_DELAY_MS: number = 500;

// A banner /usage disproved (session below 100%) is remembered — by which
// pattern matched and the reset time it carried — and never verified again:
// re-opening the panel for it would find the same answer. A later banner with a
// different reset time is a different banner and still gets checked. It's
// re-armed when a real limit is hit, or after this long, by which point the same
// clock time belongs to a later session (and a pattern that carries no time at
// all — where every banner looks alike — is only muted for this long).
const DISPROVED_LIMIT_WINDOW_MS: number = 3 * 60 * 60 * 1000;

// When /usage couldn't be read at all we've learned nothing about the banner, so
// this is a plain retry backoff — long enough that the popup isn't disruptive.
const USAGE_RETRY_COOLDOWN_MS: number = 5 * 60 * 1000;

// Safety margin added on top of the /usage reset time before we resume.
const WAIT_BUFFER_MS: number = 60 * 1000;

// A reset the panel reports as already past still has to leave a gap before we
// resume, or a limit that's in fact still live would spin: resume, banner,
// verify, resume, seconds apart. It happens when a reset has only just gone by,
// and it happens for as long as hours if the machine's clock is offset from the
// timezone /usage prints its times in. A session reset rolls forward a whole day
// on its own (resumeTimeFrom); a weekly date is absolute and can't, so this is
// the backstop for it.
const MIN_WAIT_MS: number = 5 * 60 * 1000;

// A spent session doesn't always leave us with nothing to do but wait. Claude
// Code can offer a way to keep going right now, on spare capacity, billed against
// the weekly quota, and it prints that offer beneath the limit:
//
//   ⚠ /low-priority to continue now at lower priority · uses your weekly limit
//
// When that line is live we take the offer instead of counting down to a reset:
// submitting the command carries the session straight on (Claude re-prompts
// itself to finish the interrupted work). The offer is only ever printed beside a
// limit that's blocking right now, which makes it its own confirmation — so this
// path skips the /usage read entirely.
//
// Matched against the rendered screen, so: the warning glyph has to open the
// line, which stops prose that merely mentions the command from tripping it; the
// gaps are lenient, because the line re-wraps at narrow widths; and only the
// stable opening of the sentence is required, not the "· uses your weekly limit"
// footnote, which is the half most likely to be reworded.
const LOW_PRIORITY_COMMAND: string = '/low-priority';
const lowPriorityOfferRegex: RegExp =
    /(?:^|\n)[ \t]*⚠[ \t]*\/low-priority\s+to\s+continue\s+now/i;

// The command is a toggle — a second one switches low priority back *off* — so
// sending it twice is worse than useless. Detection is held off from the moment
// we type it until Claude's echo of it is on screen and takes that job over (see
// LOW_PRIORITY_MARKER).
const LOW_PRIORITY_GRACE_MS: number = 5000;

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
// changes, a stale banner would be re-detected — one /usage check, then quiet for
// DISPROVED_LIMIT_WINDOW_MS — a safe failure, but confirm it against an
// --auto-debug screen capture (logScreen writes exactly what we match here).
const RESUME_CONTINUE_MARKER: string = '❯ ' + RESUME_CONTINUE_TEXT;

// Submitting /low-priority leaves the same kind of trace, and it means the same
// thing: whatever sits above it is a stop we've already dealt with. So the two
// are one test — a limit banner, checkpoint, error or /low-priority offer with
// either marker below it is scrollback, not a live stop.
const LOW_PRIORITY_MARKER: string = '❯ ' + LOW_PRIORITY_COMMAND;
const HANDLED_STOP_MARKERS: readonly string[] = [RESUME_CONTINUE_MARKER, LOW_PRIORITY_MARKER];

// Ctrl-U clears the input line in Claude Code; the draft can wrap, so we fire it
// a few times to wipe the whole composer before typing our own command.
const CLEAR_INPUT_SEQUENCE: string = '\x15'.repeat(8);

// F4 cancels an in-progress countdown. Terminals send F4 either as the SS3
// sequence ESC O S or as the CSI form ESC [ 14 ~; we match both.
const F4_SEQUENCES: string[] = ['\x1bOS', '\x1b[14~'];

// How often we snapshot the rendered screen in debug mode (and run limit detection on it).
const SCREEN_CAPTURE_INTERVAL_MS: number = 2000;
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
// UPDATE NOTICE
// ==========================================
// A global npm install never updates itself, so a user can sit on an old build
// indefinitely. That matters more here than for most tools: limit detection
// keys off Claude Code's rendered wording, so when that wording changes, an
// outdated copy stops resuming *silently* — it looks like claude-glm-auto is broken
// rather than stale. So we tell them a newer version exists.
//
// Two constraints shape this, and neither is negotiable:
//   1. Claude owns the terminal while it runs. Writing anything to stdout mid-
//      session corrupts its render, so the notice is printed only from cleanup(),
//      once the pty is gone and the screen is ours again. It goes to stderr so
//      that `claude-glm-auto -p '...' > out.txt` keeps a clean stdout.
//   2. A session must never wait on the network. So we never fetch-then-print:
//      we print from a cache a *previous* run wrote, and refresh that cache in
//      the background. First run shows nothing; every run after is instant.
const PACKAGE_NAME: string = '@hotox/claude-glm-auto';
const REGISTRY_URL: string = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_CACHE_FILE: string = path.join(os.homedir(), '.claude-glm-auto', 'update-check.json');

// How stale the cache may get before we refresh it. The notice is a nudge, not
// news — checking once a day is plenty and keeps us off the registry.
const UPDATE_CHECK_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

// The refresh is fire-and-forget, but an abandoned socket would still hold the
// event loop open at exit, so it gets a hard deadline.
const UPDATE_FETCH_TIMEOUT_MS: number = 3000;

// Opt-out for anyone who doesn't want the check (or is offline/air-gapped).
const UPDATE_OPT_OUT_ENV: string = 'CLAUDE_AUTO_NO_UPDATE_CHECK';

interface UpdateCache {
    checkedAt: number;
    latest: string;
}

const requireFrom = createRequire(import.meta.url);

// package.json sits next to the source in dev but one level up from dist/ once
// installed. Rather than guess the layout, try both and take whichever is
// actually ours — checking the name means a stray package.json can't fool us.
function readOwnVersion(): string {
    for (const rel of ['./package.json', '../package.json']) {
        try {
            const pkg = requireFrom(rel) as { name?: string; version?: string };
            if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
        } catch {
            /* not there — try the next candidate */
        }
    }
    return '0.0.0'; // unknown version: compares older than everything, so we stay quiet
}

const VERSION: string = readOwnVersion();

// True when `latest` is strictly ahead of `current`. Compares major/minor/patch
// numerically and ignores any prerelease suffix: we only ever read the `latest`
// dist-tag, so a prerelease can't show up here unless someone tags one as latest.
function isNewer(latest: string, current: string): boolean {
    const parts = (v: string): number[] =>
        v.split('-')[0]!.split('.').map(n => parseInt(n, 10) || 0);
    const [a, b] = [parts(latest), parts(current)];
    for (let i = 0; i < 3; i++) {
        const [x, y] = [a[i] ?? 0, b[i] ?? 0];
        if (x !== y) return x > y;
    }
    return false;
}

function readUpdateCache(): UpdateCache | null {
    try {
        return JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8')) as UpdateCache;
    } catch {
        return null; // absent or corrupt — treated the same: nothing to say yet
    }
}

// Refresh the cache for the *next* run. Deliberately not awaited: nothing in
// this process depends on the result, and unref'ing the timeout means a slow
// registry can never hold the exit open.
function refreshUpdateCache(): void {
    const cache = readUpdateCache();
    if (cache && Date.now() - cache.checkedAt < UPDATE_CHECK_INTERVAL_MS) return;

    void (async (): Promise<void> => {
        try {
            const res = await fetch(REGISTRY_URL, {
                signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
                headers: { accept: 'application/vnd.npm.install-v1+json' }
            });
            if (!res.ok) return;
            const { version } = await res.json() as { version?: string };
            if (!version) return;

            const next: UpdateCache = { checkedAt: Date.now(), latest: version };
            fs.mkdirSync(path.dirname(UPDATE_CACHE_FILE), { recursive: true });
            fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(next));
            log(`update check: latest=${version} current=${VERSION}`);
        } catch {
            /* offline, rate-limited, registry down — a nudge isn't worth a warning */
        }
    })();
}

// Called from cleanup(), i.e. only once the pty is dead. Reads the cache the
// previous run left behind; never touches the network.
function printUpdateNotice(): void {
    if (process.env[UPDATE_OPT_OUT_ENV] === '1') return;
    // Not a terminal? Then stderr is a log or a pipe, and this is just noise.
    if (!process.stderr.isTTY) return;

    const cache = readUpdateCache();
    if (!cache?.latest || !isNewer(cache.latest, VERSION)) return;

    process.stderr.write(
        `\nclaude-glm-auto ${VERSION} → ${cache.latest} — update with:\n` +
        `  npm install -g ${PACKAGE_NAME}@latest\n`
    );
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

// Which file a POSIX shell actually re-reads on launch. Nothing here is a guess
// we can make from the OS alone — it's the shell that decides, so we read $SHELL.
function posixTarget(): AliasTarget | null {
    const name: string = path.basename(process.env.SHELL ?? '');
    const home: string = os.homedir();

    if (name.includes('fish')) {
        const file: string = path.join(home, '.config', 'fish', 'config.fish');
        return { shell: 'fish', file, line: 'alias claude claude-glm-auto', reload: `source ${file}` };
    }
    if (name.includes('zsh')) {
        // ZDOTDIR moves the whole zsh config elsewhere; when it's set, .zshrc there is the one being read.
        const file: string = path.join(process.env.ZDOTDIR || home, '.zshrc');
        return { shell: 'zsh', file, line: "alias claude='claude-glm-auto'", reload: `source ${file}` };
    }
    if (name.includes('bash')) {
        // On macOS, Terminal.app opens *login* shells, which read .bash_profile and
        // never .bashrc. Everywhere else .bashrc is the interactive-shell file.
        const file: string = path.join(home, os.platform() === 'darwin' ? '.bash_profile' : '.bashrc');
        return { shell: 'bash', file, line: "alias claude='claude-glm-auto'", reload: `source ${file}` };
    }
    return null;
}

// PowerShell knows where its own profile lives ($PROFILE), and the path isn't
// reliably derivable from outside — Documents can be redirected to OneDrive, and
// pwsh and Windows PowerShell use different folders. So we ask each one that's
// installed, and install into every profile we get back: the user may well use both.
function powershellTargets(): AliasTarget[] {
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
                    line: 'Set-Alias claude claude-glm-auto',
                    reload: `. $PROFILE`
                });
            }
        } catch {
            /* not installed, or refused to run — try the other one */
        }
    }
    return targets;
}

function aliasTargets(): AliasTarget[] {
    // The shell we were launched from decides this, not the platform: Git Bash and
    // MSYS run on Windows, set $SHELL, and read the usual POSIX startup files. So a
    // POSIX shell wins wherever we find one, and PowerShell is what "Windows, and no
    // $SHELL" means. (cmd.exe also lands here — it has no startup file at all, which
    // is why the empty-targets message below sends those users to PowerShell.)
    const posix: AliasTarget | null = posixTarget();
    if (posix) return [posix];
    return os.platform() === 'win32' ? powershellTargets() : [];
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
    const targets: AliasTarget[] = aliasTargets();
    const out = (msg: string): void => { process.stdout.write(msg + '\n'); };

    if (targets.length === 0) {
        out(
            "claude-glm-auto: couldn't work out which shell to write to.\n" +
            '  Add the alias to your shell\'s startup file by hand:\n' +
            "    bash/zsh   alias claude='claude-glm-auto'      (~/.bashrc, ~/.zshrc)\n" +
            '    fish       alias --save claude claude-glm-auto\n' +
            '    PowerShell Set-Alias claude claude-glm-auto    ($PROFILE)\n' +
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

// Claude is already starting; this rides along in the background and only
// affects what the *next* run prints.
refreshUpdateCache();

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
let isVerifying: boolean = false;   // /usage panel is open for verification
let isHandlingMenu: boolean = false; // selecting the wait-for-reset menu
let isHandlingLowPriority: boolean = false; // /low-priority submitted, waiting for its echo
let countdownInterval: NodeJS.Timeout | null = null;
let disprovedBannerKey: string | null = null; // identity of the banner /usage said wasn't a limit
let disprovedAt: number = 0;                  // wall-clock time /usage disproved it
let usageRetryUntil: number = 0;              // no /usage re-read before this (read failed)
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

// Put back the title Claude last set. If it never set one, that's the empty
// title an untitled window has anyway. No-op unless the countdown took it over.
function restoreTitle(): void {
    if (!titleOverridden) return;
    titleOverridden = false;
    setTitle(childTitle);
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

// Forward everything the user types straight to Claude. The one exception: while
// a countdown is running, F4 cancels it (and is swallowed so it never reaches
// Claude). When no countdown is active, F4 passes through untouched.
process.stdin.on('data', (data: string) => {
    if (isWaiting && F4_SEQUENCES.some(seq => data.includes(seq))) {
        cancelCountdown();
        let rest = data;
        for (const seq of F4_SEQUENCES) rest = rest.split(seq).join('');
        if (rest.length > 0) ptyProcess.write(rest);
        return;
    }
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
    restoreTitle();
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* terminal already gone */ }
    process.stdin.pause();
    // From here on the pty is gone, so the screen is finally ours to write to.
    // If the first-run trust dialog was shown, the alt-screen restore has just
    // brought its stale lines back onto the main screen; clear them so the shell
    // prompt returns to a clean screen instead of mid-dialog.
    const resetSeq: string = onboardingSeen ? TERMINAL_RESET + ONBOARDING_CLEAR : TERMINAL_RESET;
    try { process.stdout.write(resetSeq); } catch { /* terminal already gone */ }
    printUpdateNotice();
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
    // Capture the screen state every x seconds
    captureInterval = setInterval(() => {
        // Already handling a limit (waiting it out or mid-verification) — do nothing.
        if (isWaiting || isVerifying || isHandlingMenu || isHandlingLowPriority) return;
        currentScreen = captureScreen();
        onScreenCapture();
    }, SCREEN_CAPTURE_INTERVAL_MS);
}
main();

function onScreenCapture(): void {
    logScreen();
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
// Parse a reset clock time match into minutes-of-day (0–1439), or null when the
// pattern didn't capture one. Both the banner patterns and the /usage regex put
// (hours)(:minutes)(am/pm) in groups 1–3 — but a limit phrase need not carry a
// time at all (see LIMIT_PATTERNS), in which case there's nothing to parse.
function resetMinutes(match: RegExpMatchArray): number | null {
    if (match[1] === undefined || match[3] === undefined) return null;
    let hours: number = parseInt(match[1], 10);
    const minutes: number = match[2] ? parseInt(match[2], 10) : 0;
    const ampm: string = match[3].toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

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

interface LimitBanner {
    index: number;   // where it starts on screen, for the staleness test
    text: string;    // what matched, for the log
    key: string;     // identity for the disproof memo
}

// The newest banner of one kind on screen, whichever phrasing it used: every
// pattern is searched and the one furthest down wins, because that's the one
// that says whether we're still stopped.
//
// `key` is what a disproof is remembered under, so it has to name the *limit*,
// not the pixels: the kind, the pattern that matched, and the reset time it
// carried. Two renders of one banner (re-wrapped, or with a live "try again in
// 34m" inside the match) share a key; a later limit resetting at a different time
// doesn't, so it's verified afresh. A phrase carrying no time has one key for all
// its banners — every one after a disproof stays muted for
// DISPROVED_LIMIT_WINDOW_MS. The kind is in the key so that a disproved
// checkpoint can't mute a limit banner, or the other way round.
function newestBanner(screen: string, patterns: RegExp[], kind: string): LimitBanner | null {
    let newest: LimitBanner | null = null;
    for (const [patternIndex, pattern] of patterns.entries()) {
        const found = lastMatch(screen, pattern);
        if (found === null) continue;
        if (newest !== null && found.index <= newest.index) continue;
        const minutes: number | null = resetMinutes(found.match);
        newest = {
            index: found.index,
            text: found.match[0],
            key: `${kind}#${patternIndex}@${minutes ?? 'no-reset-time'}`,
        };
    }
    return newest;
}

// True when something we sent to get a stopped session moving again — the
// "continue" from a countdown, or a /low-priority — sits below `index`, i.e. we
// have already dealt with whatever we matched there, so it's stale scrollback.
// See HANDLED_STOP_MARKERS: a genuinely live banner, offer or error renders below
// the last of them, so nothing follows it and it still gets handled.
function alreadyHandledPast(screen: string, index: number): boolean {
    const below: string = screen.slice(index);
    return HANDLED_STOP_MARKERS.some(marker => below.includes(marker));
}

// A /low-priority offer that's still live: on screen, and with nothing we've
// already sent below it. Both halves matter — the offer printed beside a limit we
// have *already* taken it for stays on screen, and acting on it a second time
// would toggle the session back to normal priority.
function hasLiveLowPriorityOffer(screen: string): boolean {
    const offer = lastMatch(screen, lowPriorityOfferRegex);
    return offer !== null && !alreadyHandledPast(screen, offer.index);
}

// True while Claude's resume-from-summary question is on screen. Answering it is
// the user's call, so we send nothing — not /usage, not the resume.
function hasResumePrompt(screen: string): boolean {
    return screen.toLowerCase().includes(RESUME_PROMPT_TEXT);
}

function detectLimit(screen: string): void {
    // Already handling a limit (waiting it out or mid-verification) — do nothing.
    if (isWaiting || isVerifying || isHandlingMenu || isHandlingLowPriority) return;

    // Scrolled-up history is stale; ignore it.
    if (screen.includes(SCROLL_INDICATOR)) return;

    // Checked before the menu below, which would answer this question with its Enter.
    if (hasResumePrompt(screen)) {
        log('Resume-from-summary question on screen — detection paused');
        return;
    }

    // Auto-select Claude's "Stop and wait for limit to reset" menu when shown.
    // While the menu is on screen we never run limit detection (it would type
    // "/usage" into the menu), so handle it here and bail out.
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

    // A session limit outranks a 529: if we're out of quota, retrying in five
    // minutes would just hit the limit again. A checkpoint outranks it for the
    // same reason — "● Claude usage limit reached" is quota, not an overload —
    // but it comes second, since an outright limit banner is the better evidence
    // when both are on screen.
    if (handleLimitBanner(screen)) return;
    if (handleCheckpointBanner(screen)) return;
    handleApiError(screen);
}

// A limit banner and a checkpoint are the same situation — the session has
// stopped and won't restart on its own — so both run through one handler, and
// with it one set of safeguards: the staleness test, the /low-priority shortcut,
// the disproof memo, the /usage backoff, and the /usage confirmation itself. The
// only thing that differs is how full the session bar has to read before the
// stop counts as real (see CHECKPOINT_CONFIRM_PCT).
//
// Returns true when a live banner was found and verification started, so the
// caller knows the screen is spoken for.
function handleStopBanner(
    screen: string,
    banner: LimitBanner | null,
    label: string,
    sessionConfirmPct: number,
): boolean {
    if (banner === null) return false;

    // If something we sent to get the session going again — a resumed "continue",
    // a /low-priority — sits below the banner, we've already dealt with it and this
    // is stale scrollback, so ignore it. A genuinely still-live stop renders below
    // the last of those, so it has nothing after it and falls through.
    if (alreadyHandledPast(screen, banner.index)) {
        log(`${label} sits above a resume we already sent — ignoring as stale`);
        return false;
    }

    // Claude is offering to continue right now at lower priority. That beats
    // every path below: there's no reset to wait for, and no /usage read to do —
    // the offer only shows up beside a limit that's blocking right now, so it
    // confirms the banner by being there. Checked before the disproof memo and
    // the /usage backoff, both of which exist only to keep us from re-opening
    // the panel, which this doesn't do.
    if (hasLiveLowPriorityOffer(screen)) {
        log(`${label} with a live /low-priority offer — continuing at lower priority`);
        sendLowPriority();
        return true;
    }

    // This exact banner was already checked against /usage and disproved. Opening
    // the panel again would only find the same answer, so leave it alone until a
    // real limit re-arms detection or the window expires.
    if (disprovedBannerKey !== null &&
        banner.key === disprovedBannerKey &&
        Date.now() - disprovedAt < DISPROVED_LIMIT_WINDOW_MS) {
        log(`Same ${label.toLowerCase()} /usage already disproved — ignoring`);
        return false;
    }

    // A previous /usage read failed; back off before opening the panel again.
    if (Date.now() < usageRetryUntil) {
        log(`${label} on screen but inside /usage retry backoff — ignoring`);
        return false;
    }

    // Candidate stop on the live screen. Confirm it against /usage: the banner is
    // only trusted when the Current session bar actually reads full enough.
    log(`Possible ${label.toLowerCase()} ("${banner.text.replace(/\s+/g, ' ').trim()}")` +
        ` — opening /usage to verify against ${sessionConfirmPct}%`);
    isVerifying = true;
    verifyViaUsage(banner.key, sessionConfirmPct)
        .catch(err => log(`/usage verification error: ${err}`))
        .finally(() => { isVerifying = false; });
    return true;
}

// "You've hit your …" — Claude saying the quota is gone. Only a bar at
// USAGE_CONFIRM_PCT confirms it.
function handleLimitBanner(screen: string): boolean {
    return handleStopBanner(
        screen, newestBanner(screen, LIMIT_PATTERNS, 'limit'), 'Limit banner', USAGE_CONFIRM_PCT);
}

// "● Checkpoint …" — Claude stopping itself just short of the limit. Same
// handling, lower bar: at 100% it would never fire, since the whole point of a
// checkpoint is that it lands before the session is spent.
function handleCheckpointBanner(screen: string): boolean {
    return handleStopBanner(
        screen, newestBanner(screen, CHECKPOINT_PATTERNS, 'checkpoint'), 'Checkpoint', CHECKPOINT_CONFIRM_PCT);
}

// Submit /low-priority, in the same two steps as /usage: type it, let the
// autocomplete settle on it, then Enter. Detection stays out of the way until
// Claude's echo of the command is on screen, from where LOW_PRIORITY_MARKER keeps
// the limit above it from being re-detected — and keeps the offer beside it from
// being taken a second time, which would switch low priority back off.
function sendLowPriority(): void {
    isHandlingLowPriority = true;
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + LOW_PRIORITY_COMMAND);
    setTimeout(() => {
        ptyProcess.write('\r');
        setTimeout(() => { isHandlingLowPriority = false; }, LOW_PRIORITY_GRACE_MS);
    }, SLASH_MENU_SETTLE_MS);
}

// A 529 is transient, so there is no panel to confirm it against — the screen is
// the whole evidence. It goes through the same guards as a limit banner
// (scrolled-up history, the resume question, the wait-for-reset menu, and the
// staleness test), then just waits it out.
function handleApiError(screen: string): void {
    const error = lastMatch(screen, apiErrorRegex);
    if (error === null) return;

    if (alreadyHandledPast(screen, error.index)) {
        log('API error sits above a resume we already sent — ignoring as stale');
        return;
    }

    log(`API error 529 on screen — retrying in ${API_ERROR_COOLDOWN_MS / 60000} min`);
    startCountdown(Date.now() + API_ERROR_COOLDOWN_MS);
}

// ==========================================
// /usage VERIFICATION
// ==========================================
interface UsageReading {
    sessionPercentUsed: number;
    sessionResetMinutesOfDay: number | null; // the panel omits it while the bar reads 0%
    weeklyPercentUsed: number | null;        // null when the panel shows no weekly row
    weeklyResetAtMs: number | null;
}

// Read the panel and decide. `sessionConfirmPct` is how full the session bar has
// to read for the banner that sent us here to count as real: USAGE_CONFIRM_PCT
// for a limit banner, the lower CHECKPOINT_CONFIRM_PCT for a checkpoint. The
// weekly bar is always held to USAGE_CONFIRM_PCT — see CHECKPOINT_CONFIRM_PCT.
async function verifyViaUsage(bannerKey: string, sessionConfirmPct: number): Promise<void> {
    const usage = await readUsagePanel();
    if (usage === null) {
        usageRetryUntil = Date.now() + USAGE_RETRY_COOLDOWN_MS;
        log('Could not read the Current session block from /usage — will retry after backoff');
        return;
    }
    log(`/usage read: session ${usage.sessionPercentUsed}% used` +
        `, resets at minutes-of-day ${usage.sessionResetMinutesOfDay ?? 'n/a'}` +
        `; week ${usage.weeklyPercentUsed ?? 'n/a'}% used` +
        `, resets ${usage.weeklyResetAtMs === null ? 'n/a' : new Date(usage.weeklyResetAtMs).toLocaleString()}`);

    // The limits that are actually spent, each with the moment it comes back.
    // Either bar stops the session on its own, so both are collected: we
    // wait for the last of them, since resuming while the other is still spent
    // would only walk into the banner again.
    const exhausted: { name: string; resumeAt: number | null }[] = [];
    if (usage.sessionPercentUsed >= sessionConfirmPct) {
        exhausted.push({
            name: 'session',
            resumeAt: usage.sessionResetMinutesOfDay === null
                ? null
                : resumeTimeFrom(usage.sessionResetMinutesOfDay),
        });
    }
    if (usage.weeklyPercentUsed !== null && usage.weeklyPercentUsed >= USAGE_CONFIRM_PCT) {
        // Already an absolute date, so unlike the session it needs no rolling
        // forward — only the same safety margin.
        exhausted.push({
            name: 'week',
            resumeAt: usage.weeklyResetAtMs === null ? null : usage.weeklyResetAtMs + WAIT_BUFFER_MS,
        });
    }

    if (exhausted.length === 0) {
        disprovedBannerKey = bannerKey;
        disprovedAt = Date.now();
        log(`Session below ${sessionConfirmPct}% and week below ${USAGE_CONFIRM_PCT}%` +
            ` — banner ${bannerKey} is stale, ignoring it from now on`);
        return;
    }

    // A spent limit whose reset line didn't parse can't be counted down to, and
    // it isn't a disproof either — the limit is real. Fall back to any other
    // spent limit, and if there's none, treat the read as failed and retry.
    const resumeTimes: number[] = [];
    for (const limit of exhausted) {
        if (limit.resumeAt === null) log(`The ${limit.name} limit is spent but its reset line didn't parse`);
        else resumeTimes.push(limit.resumeAt);
    }
    if (resumeTimes.length === 0) {
        usageRetryUntil = Date.now() + USAGE_RETRY_COOLDOWN_MS;
        log('Limit confirmed but no reset time to count down to — will retry after backoff');
        return;
    }

    // A real limit ends any prior disproof: whatever banner we'd written off
    // belongs to a session that's over, so the next one gets verified again.
    disprovedBannerKey = null;
    disprovedAt = 0;
    usageRetryUntil = 0;

    log(`Confirmed by /usage: ${exhausted.map(l => l.name).join(' + ')} spent`);
    const resumeAt: number = Math.max(...resumeTimes);
    startCountdown(resumeAt < Date.now() ? Date.now() + MIN_WAIT_MS : resumeAt);
}

// The absolute time to resume at, from a reset clock time in minutes-of-day:
// today's occurrence plus the safety margin, or tomorrow's if that's already past.
function resumeTimeFrom(targetMinutesOfDay: number): number {
    const hours = Math.floor(targetMinutesOfDay / 60);
    const minutes = targetMinutesOfDay % 60;

    const now = new Date();
    let targetTimeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0).getTime();
    targetTimeMs += WAIT_BUFFER_MS;
    if (targetTimeMs < Date.now()) {
        targetTimeMs += 24 * 60 * 60 * 1000;
    }
    return targetTimeMs;
}

// Every heading on screen, in the order they appear. A heading overlapping one
// already found is dropped, which is what keeps "Current week (all models)" from
// being taken for the bare "current week" terminator as well: USAGE_HEADINGS
// lists the specific pattern first, so the specific one claims the spot.
function findHeadings(screen: string): { index: number; end: number; section: UsageSection }[] {
    const found: { index: number; end: number; section: UsageSection }[] = [];
    for (const { section, pattern } of USAGE_HEADINGS) {
        const re: RegExp = new RegExp(pattern.source, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(screen)) !== null) {
            const [index, end] = [m.index, m.index + m[0].length];
            if (found.some(h => index < h.end && h.index < end)) continue;
            found.push({ index, end, section });
        }
    }
    return found.sort((a, b) => a.index - b.index);
}

// The visible panel cut into its sections. `carried` is the section the previous
// screen ended in: the panel scrolls a line at a time, so a block's tail often
// arrives with its own heading already off the top, and that text still belongs
// to it. With nothing carried, text above the first heading (the cost summary at
// the top of the panel) belongs to no limit and is dropped.
function splitIntoSections(screen: string, carried: UsageSection | null): { section: UsageSection; text: string }[] {
    const headings = findHeadings(screen);
    const regions: { section: UsageSection; text: string }[] = [];
    const firstIdx: number = headings[0]?.index ?? screen.length;
    if (carried !== null && firstIdx > 0) regions.push({ section: carried, text: screen.slice(0, firstIdx) });
    for (const [i, heading] of headings.entries()) {
        regions.push({ section: heading.section, text: screen.slice(heading.index, headings[i + 1]?.index ?? screen.length) });
    }
    return regions;
}

// Absolute time for a weekly reset line ("Resets Jul 22, 8am"), or null if the
// month name isn't one. Groups: month, day, hours, optional minutes, am/pm. The
// panel prints no year, so we take the current one and step forward when that
// lands well in the past — a weekly reset is always ahead of us, so a January
// date read in late December belongs to next year.
function weeklyResetTime(match: RegExpMatchArray): number | null {
    const month: number = MONTH_ABBREVIATIONS.indexOf(match[1]!.slice(0, 3).toLowerCase());
    if (month === -1) return null;
    const day: number = parseInt(match[2]!, 10);
    let hours: number = parseInt(match[3]!, 10);
    const minutes: number = match[4] ? parseInt(match[4], 10) : 0;
    const ampm: string = match[5]!.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    const now = new Date();
    const at = (year: number): number => new Date(year, month, day, hours, minutes, 0, 0).getTime();
    const thisYear: number = at(now.getFullYear());
    return thisYear < Date.now() - USAGE_WEEKLY_BACKDATE_MS ? at(now.getFullYear() + 1) : thisYear;
}

// Open the /usage panel and read the bars that can block a session: the current
// one and the plan's weekly quota. When the window is too small to show them at
// once, scroll the panel one step at a time and keep reading until everything
// the decision needs has been seen. Always closes the panel (Esc) before
// returning; null means even the session bar couldn't be read.
async function readUsagePanel(): Promise<UsageReading | null> {
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + USAGE_COMMAND);
    await sleep(SLASH_MENU_SETTLE_MS);
    ptyProcess.write('\r');
    await sleep(USAGE_RENDER_DELAY_MS);

    let sessionPercent: number | null = null;
    let sessionReset: number | null = null;
    let weeklyPercent: number | null = null;
    let weeklyResetAtMs: number | null = null;
    let openSection: UsageSection | null = null; // section the next screen opens in
    let previousScreen: string | null = null;

    for (let step = 0; step <= USAGE_MAX_SCROLL_STEPS; step++) {
        const screen = captureScreen();
        logScreen(screen, `/usage screen (scroll step ${step})`);

        // A scroll that changed nothing means we're at the bottom of the panel;
        // whatever we haven't found by now isn't there.
        if (screen === previousScreen) {
            log('/usage screen unchanged after scroll — reached the bottom');
            break;
        }
        previousScreen = screen;

        // Values are only ever taken from the section they belong to, so the
        // weekly rows — which also say "% used" — can't be read as the session
        // bar, or the other way round.
        for (const region of splitIntoSections(screen, openSection)) {
            openSection = region.section;
            if (region.section === 'session') {
                if (sessionPercent === null) {
                    const m = region.text.match(usagePercentRegex);
                    if (m) sessionPercent = parseInt(m[1]!, 10);
                }
                if (sessionReset === null) {
                    const m = region.text.match(usageResetRegex);
                    if (m) sessionReset = resetMinutes(m);
                }
            } else if (region.section === 'weekly') {
                if (weeklyPercent === null) {
                    const m = region.text.match(usagePercentRegex);
                    if (m) weeklyPercent = parseInt(m[1]!, 10);
                }
                if (weeklyResetAtMs === null) {
                    const m = region.text.match(usageWeeklyResetRegex);
                    if (m) weeklyResetAtMs = weeklyResetTime(m);
                }
            }
        }

        // A bar below 100% is one we'll never wait on, so its reset time isn't
        // needed — which is just as well, since the session prints none at all
        // while it reads 0%. On a plan with no weekly row nothing completes the
        // weekly half and we simply scroll to the bottom, which is where the
        // unchanged-screen check above stops us.
        const sessionRead: boolean = sessionPercent !== null &&
            (sessionPercent < USAGE_CONFIRM_PCT || sessionReset !== null);
        const weeklyRead: boolean = weeklyPercent !== null &&
            (weeklyPercent < USAGE_CONFIRM_PCT || weeklyResetAtMs !== null);
        if (sessionRead && weeklyRead) break;

        if (step < USAGE_MAX_SCROLL_STEPS) {
            ptyProcess.write(USAGE_SCROLL_KEY);
            await sleep(USAGE_SCROLL_DELAY_MS);
        }
    }

    // log("Closing the window")
    // ptyProcess.write(USAGE_CLOSE_KEY);
    // ptyProcess.write(USAGE_CLOSE_KEY);
    // await sleep(USAGE_CLOSE_DELAY_MS);
    // ptyProcess.write(' \x08');
    // await sleep(200);
    // log("Window closed")

    log("Closing the window")
    ptyProcess.write(USAGE_CLOSE_KEY);
    await sleep(100);
    ptyProcess.write('\x1b[<35;1;1M');
    await sleep(USAGE_CLOSE_DELAY_MS);
    log("Window closed")

    if (sessionPercent === null) return null;
    return {
        sessionPercentUsed: sessionPercent,
        sessionResetMinutesOfDay: sessionReset,
        weeklyPercentUsed: weeklyPercent,
        weeklyResetAtMs,
    };
}

// Wait until `targetTimeMs`, then send "continue". The target is either the
// authoritative reset time /usage gave us, or a short cooldown after a 529. From
// here until we resume, detection is paused (isWaiting), so nothing re-enters.
function startCountdown(targetTimeMs: number): void {
    isWaiting = true;

    // From here on the title is ours; restoreTitle() hands it back.
    titleOverridden = true;

    log(`Resuming at ${new Date(targetTimeMs).toLocaleString()}`);

    countdownInterval = setInterval(() => {
        const remainingMs = targetTimeMs - Date.now();

        if (remainingMs > 0) {
            const totalSeconds = Math.floor(remainingMs / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            const timeStr = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
            setTitle(`⏳ Claude Resumes: ${timeStr}`);
            return;
        }

        // Quota should be back, but the resume-from-summary question is up: our
        // Enter would answer it. Hold the countdown open and try again next tick,
        // so the session resumes the moment the user has answered.
        if (hasResumePrompt(captureScreen())) {
            log('Timer elapsed but resume-from-summary question is up — holding');
            setTitle('⏳ Claude Resumes: waiting for your answer');
            return;
        }

        clearInterval(countdownInterval!);
        countdownInterval = null;
        isWaiting = false;
        // Hand the title back to Claude and resume the session.
        restoreTitle();
        // "continue" lands in the transcript just below the banner we waited out,
        // which is what stops detectLimit re-reading that stale banner (see
        // RESUME_CONTINUE_MARKER). If the reset was early and the limit is still
        // live, the next banner renders below this continue and is verified.
        log('Timer elapsed — sending "continue" to resume');
        ptyProcess.write(CLEAR_INPUT_SEQUENCE + RESUME_CONTINUE_TEXT + '\r');
    }, 1000);
}

// Cancel an in-progress countdown (triggered by F4). Clears the disproof and
// backoff state so the very same limit can be detected again immediately.
function cancelCountdown(): void {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    restoreTitle();
    isWaiting = false;
    disprovedBannerKey = null;
    disprovedAt = 0;
    usageRetryUntil = 0;
    log('Countdown cancelled (F4) — detection re-armed');
}

