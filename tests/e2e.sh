#!/usr/bin/env bash
# E2E suite for claude-glm-auto, at CGA_TIME_SCALE=0.01 (5 min -> 3 s).
#
# Each scenario runs the wrapper around tests/fake-claude.sh with the quota
# API pointed at a local mock (tests/mock-quota.py) whose state file the
# scenario can flip mid-run. The wrapper's stdin is a FIFO held open by a
# sleeper, so scenarios can inject keystrokes at chosen moments.
#
# Usage: tests/e2e.sh            (from anywhere)
set -u
cd "$(dirname "$0")/.."

REPO="$PWD"
PORT=18931
T=$(mktemp -d)
STATE="$T/state.json"
FIFO="$T/stdin.fifo"
LOG="$T/claude-glm-auto.log"
PROFILE="$T/profile"
mkdir -p "$PROFILE"
export CLAUDE_CONFIG_DIR="$PROFILE"
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
export ANTHROPIC_AUTH_TOKEN=test-direct
unset GLM_QUOTA_URL

PASS=0; FAIL=0

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
check() { # check <description> <grep-pattern> <file> [min-count]
    local desc="$1" pat="$2" file="$3" min="${4:-1}"
    local n; n=$(grep -ac "$pat" "$file" 2>/dev/null); n=${n:-0}
    if (( n >= min )); then ok "$desc ($n)"; else bad "$desc (wanted >=$min, got $n)"; fi
}
check_absent() {
    local desc="$1" pat="$2" file="$3"
    if grep -qa "$pat" "$file" 2>/dev/null; then bad "$desc (pattern present)"; else ok "$desc"; fi
}

NOW_MS() { python3 -c 'import time;print(int(time.time()*1000))'; }
set_state() { printf '%s' "$1" > "$STATE"; }

# run_wrapper <seconds> [inject-after-s] [inject-text] [extra-wrapper-args]
run_wrapper() {
    rm -f "$LOG" "$T/out.bin" "$FIFO"; mkfifo "$FIFO"
    sleep 3600 > "$FIFO" & local holder=$!
    if [[ "${2:-}" != "" ]]; then
        ( sleep "$2"; printf '%s' "${3:-x}" > "$FIFO" 2>/dev/null || true ) &
    fi
    # shellcheck disable=SC2086 # extra args are meant to word-split
    (
      cd "$T"
      env PATH="$REPO/tests/bin:$PATH" CGA_TIME_SCALE=0.01 \
        GLM_QUOTA_URL="http://127.0.0.1:$PORT/api/monitor/usage/quota/limit" \
        python3 "$REPO/tests/run-with-timeout.py" "$1" node "$REPO/dist/claude-glm-auto.js" --auto-debug ${4:-} \
        < "$FIFO" > "$T/out.bin" 2>"$T/err.txt" || true
    )
    kill $holder 2>/dev/null || true
    wait $holder 2>/dev/null || true
    rm -f "$FIFO"
}

python3 tests/mock-quota.py "$PORT" "$STATE" & MOCK=$!
trap 'kill $MOCK 2>/dev/null; rm -rf "$T"' EXIT
sleep 0.5

# ---------------------------------------------------------------- S1 transient
say "S1: transient error at 96% quota -> fast ladder continue, never a limit wait"
set_state "{\"status\":200,\"tokensPct\":96,\"tokensResetMs\":$(( $(NOW_MS) + 3600000 ))}"
FAKE_BANNER='● API Error: Connection closed mid-response. The response above may be incomplete.' \
FAKE_NEXT='-' run_wrapper 6
check "classified transient"        "Transient API error"             "$LOG" 1
check "sent continue (transient)"   'Sending "continue" (transient)' "$LOG" 1
check_absent "no limit wait"        "Limit wait"                      "$LOG"
check "echo landed"                 "❯ continue"                      $T/out.bin

# ------------------------------------------------------------- S2 cert error
say "S2: self-signed certificate error -> transient (quota full irrelevant)"
set_state "{\"status\":200,\"tokensPct\":99,\"tokensResetMs\":$(( $(NOW_MS) + 3600000 ))}"
FAKE_BANNER='● API Error: Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates.' \
FAKE_NEXT='-' run_wrapper 6
check "classified transient"        "Transient API error"             "$LOG" 1
check_absent "no limit wait"        "Limit wait"                      "$LOG"

# ------------------------------------------------------- S3 ladder escalation
say "S3: same transient error keeps failing -> ladder escalates"
set_state '{"status":200,"tokensPct":50,"tokensResetMs":null}'
FAKE_BANNER='● API Error: Stream idle timeout - no chunks received' \
FAKE_NEXT='loop:● API Error: Stream idle timeout - no chunks received' run_wrapper 5
check "escalated retries (>=3)"     "Transient API error"             "$LOG" 3
check ">=3 sends"                   'Sending "continue"'              "$LOG" 3

# ---------------------------------------------------------- S4 limit deadline
say "S4: 1308 limit with quota-API reset time -> countdown -> deadline resume"
RESET=$(( $(NOW_MS) + 5000 ))
set_state "{\"status\":200,\"tokensPct\":100,\"tokensResetMs\":$RESET}"
FAKE_BANNER="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
FAKE_NEXT='-' run_wrapper 8
check "limit wait started"          "Limit wait until"                "$LOG" 1
check "sent continue (deadline)"    'Sending "continue" (deadline)' "$LOG" 1
check "countdown title"             "GLM resumes"                     $T/out.bin

# ------------------------------------------------------------- S5 early resume
say "S5: window drops below 100 during the wait -> early resume; bounce -> disabled"
RESET=$(( $(NOW_MS) + 300000 ))
set_state "{\"status\":200,\"tokensPct\":100,\"tokensResetMs\":$RESET}"
( sleep 4; printf '{"status":200,"tokensPct":50,"tokensResetMs":%s}' "$RESET" > "$STATE" ) &
FLIP=$!
FAKE_BANNER="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
FAKE_NEXT="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
  run_wrapper 14
kill $FLIP 2>/dev/null || true
check "early resume fired"          "resuming early"                  "$LOG" 1
N=$(grep -ac 'Sending "continue" (quota-early)' "$LOG")
if [[ "$N" == 1 ]]; then ok "exactly one early resume"; else bad "expected one early resume, got $N"; fi
check "bounce detected"             "Early resume bounced"            "$LOG" 1

# ------------------------------------------------------------------ S6 probe
say "S6: limit text without reset time + quota API down -> probe loop"
set_state '{"status":500}'
FAKE_BANNER='● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。][x]' \
FAKE_NEXT='loop:● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。][x]' run_wrapper 10
check "API unusable noted"          "quota API unusable"              "$LOG" 1
check "probe loop started"          "probing for one"                 "$LOG" 1
check "probe continue sent"         'Sending "continue" (probe)'    "$LOG" 1

# ------------------------------------------------------------ S7 user takeover
say "S7: keystroke during limit wait cancels auto-resume"
RESET=$(( $(NOW_MS) + 300000 ))
set_state "{\"status\":200,\"tokensPct\":100,\"tokensResetMs\":$RESET}"
FAKE_BANNER="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
FAKE_NEXT='-' run_wrapper 8 3 'x'
check "takeover logged"             "Auto-resume cancelled (user input)" "$LOG" 1
check_absent "no continue sent"     'Sending "continue"'              "$LOG"

# --------------------------------------------------- S8 alias install config dir
say "S8: --install-alias --auto-config-dir pins the dir; the flag never forwards"
ALIAS_HOME="$T/alias-home"
mkdir -p "$ALIAS_HOME/.claude_ds"
if [[ $(uname) == Darwin ]]; then RC=.bash_profile; else RC=.bashrc; fi
HOME="$ALIAS_HOME" SHELL=/bin/bash node dist/claude-glm-auto.js \
    --install-alias --auto-config-dir '~/.claude_ds' >"$T/alias.txt" 2>&1
check "alias pins expanded dir"  "[-]-auto-config-dir \"$ALIAS_HOME/.claude_ds\"" "$ALIAS_HOME/$RC" 1
HOME="$ALIAS_HOME" SHELL=/bin/bash node dist/claude-glm-auto.js \
    --install-alias --auto-config-dir "$ALIAS_HOME/.claude_ds" >/dev/null 2>&1
check "reinstall stays idempotent" "alias claude=" "$ALIAS_HOME/$RC" 1
if HOME="$ALIAS_HOME" SHELL=/bin/bash node dist/claude-glm-auto.js \
    --install-alias --auto-config-dir "$ALIAS_HOME/missing" >/dev/null 2>&1; then
    bad "missing config dir refused"
else
    ok "missing config dir refused"
fi
# An exported CLAUDE_CONFIG_DIR at install time is frozen into the block too.
HOME="$ALIAS_HOME" SHELL=/bin/bash CLAUDE_CONFIG_DIR="$ALIAS_HOME/.claude_ds" \
    node dist/claude-glm-auto.js --install-alias >/dev/null 2>&1
check "env dir frozen into alias" "[-]-auto-config-dir \"$ALIAS_HOME/.claude_ds\"" "$ALIAS_HOME/$RC" 1
HOME="$ALIAS_HOME" SHELL=/bin/bash node dist/claude-glm-auto.js --uninstall-alias >/dev/null 2>&1
check_absent "uninstall drops the block" "claude-glm-auto" "$ALIAS_HOME/$RC"
# And the flag itself is stripped before forwarding to claude.
run_wrapper 3 '' '' "--auto-config-dir $ALIAS_HOME/.claude_ds"
check "wrapper started"            "===== START ====="                "$LOG" 1
check_absent "flag not forwarded"  "Forwarding to claude:.*auto-config-dir" "$LOG"

# --------------------------------------------------------- S9 multi-account
say "S9: one account weekly-exhausted, another ready -> retry through relay"
write_accounts() {
    printf '{"accounts":[{"id":"a","name":"A","apiKey":"official-a"},{"id":"b","name":"B","apiKey":"official-b"}]}' > "$PROFILE/glm-accounts.json"
}
write_accounts
set_state '{"accounts":{"official-a":{"tokensPct":20,"weeklyPct":100},"official-b":{"tokensPct":40,"weeklyPct":35}}}'
FAKE_BANNER='● API Error: [1308][已达到每周使用上限，2099-01-01 00:00:00 重置]' FAKE_NEXT='-' run_wrapper 5
check "relay retry" 'Sending "continue" (transient)' "$LOG"
check_absent "no single-account long wait" 'Limit wait until' "$LOG"

# --------------------------------------------------------- S10 pool deadline
say "S10: all accounts blocked -> earliest account recovery (including weekly)"
RESET=$(( $(NOW_MS) + 5000 ))
LATER=$(( $(NOW_MS) + 3600000 ))
set_state "{\"accounts\":{\"official-a\":{\"tokensPct\":100,\"tokensResetMs\":$RESET,\"weeklyPct\":100,\"weeklyResetMs\":$LATER},\"official-b\":{\"tokensPct\":100,\"tokensResetMs\":$RESET,\"weeklyPct\":20}}}"
FAKE_BANNER='● API Error: [1308][已达到每周使用上限]' FAKE_NEXT='-' run_wrapper 8
check "pool wait" 'Limit wait until' "$LOG"
check "pool deadline resumed" 'Sending "continue" (deadline)' "$LOG"

# --------------------------------------------------------- S11 partial failure
say "S11: unknown account prevents a multi-day wait"
set_state "{\"accounts\":{\"official-a\":{\"status\":500},\"official-b\":{\"tokensPct\":100,\"tokensResetMs\":$LATER,\"weeklyPct\":100,\"weeklyResetMs\":$LATER}}}"
FAKE_BANNER='● API Error: [1308][已达到每周使用上限，2099-01-01 00:00:00 重置]' FAKE_NEXT='-' run_wrapper 6
check_absent "no long wait based on partial data" 'Limit wait until' "$LOG"
check "bounded probe" 'Sending "continue" (probe)' "$LOG"

# --------------------------------------------------------- S12 gateway stop
say "S12: gateway balance failure -> visible stop, no model probes"
FAKE_BANNER='● API Error: 403 Insufficient balance' FAKE_NEXT='-' run_wrapper 5
check "gateway stop reason" 'Gateway stopped' "$LOG"
check_absent "no retry on gateway balance" 'Sending "continue"' "$LOG"
check "visible stop" '自动重试已停止' "$T/out.bin"

# --------------------------------------------------------- S13 add account
say "S13: third account added during wait -> resume on next poll"
set_state "{\"accounts\":{\"official-a\":{\"tokensPct\":100,\"tokensResetMs\":$LATER},\"official-b\":{\"tokensPct\":100,\"tokensResetMs\":$LATER},\"official-c\":{\"tokensPct\":20,\"weeklyPct\":15}}}"
( sleep 4; printf '{"accounts":[{"id":"a","name":"A","apiKey":"official-a"},{"id":"b","name":"B","apiKey":"official-b"},{"id":"c","name":"C","apiKey":"official-c"}]}' > "$PROFILE/glm-accounts.json" ) &
ADD=$!
FAKE_BANNER='● API Error: [1308][已达到 5 小时的使用上限]' FAKE_NEXT='-' run_wrapper 9
wait $ADD
check "wait entered before addition" 'Limit wait until' "$LOG"
check "third account early resume" 'Sending "continue" (quota-early)' "$LOG"
check "title reflects three accounts" 'GLM 未触顶 1/3' "$T/out.bin"

# --------------------------------------------------------- S14 cancel query
say "S14: user input while quota verification is in flight retires its callback"
rm "$PROFILE/glm-accounts.json"
set_state '{"tokensPct":20,"delay":2.2}'
FAKE_BANNER='● API Error: [1308][已达到 5 小时的使用上限]' FAKE_NEXT='-' run_wrapper 4 0.8 'x'
check "verification cancelled by input" 'Auto-resume cancelled (user input)' "$LOG"
check_absent "cancelled query cannot send continue" 'Sending "continue"' "$LOG"

# --------------------------------------------------------- S15 F4 cancel
say "S15: F4 cancels the active wait without forwarding the key"
RESET=$(( $(NOW_MS) + 300000 ))
set_state "{\"tokensPct\":100,\"tokensResetMs\":$RESET}"
FAKE_BANNER='● API Error: [1308][已达到 5 小时的使用上限]' FAKE_NEXT='-' run_wrapper 5 1 $'\e[14~'
check "F4 cancels wait" 'Auto-resume cancelled (F4)' "$LOG"
check_absent "no F4 resume" 'Sending "continue"' "$LOG"

# ------------------------------------------------------------------ summary
say "SUMMARY"
printf '  passed: %d, failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
