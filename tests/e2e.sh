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

PORT=18931
STATE=/tmp/cga-mock-state.json
FIFO=/tmp/cga-stdin.fifo
LOG=claude-glm-auto.log
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

# run_wrapper <seconds> [inject-after-s] [inject-text]
run_wrapper() {
    rm -f "$LOG" /tmp/cga-out.bin "$FIFO"; mkfifo "$FIFO"
    sleep 3600 > "$FIFO" & local holder=$!
    if [[ "${2:-}" != "" ]]; then
        ( sleep "$2"; printf '%s' "${3:-x}" > "$FIFO" 2>/dev/null || true ) &
    fi
    env PATH="$PWD/tests/bin:$PATH" CGA_TIME_SCALE=0.01 \
        GLM_QUOTA_URL="http://127.0.0.1:$PORT/api/monitor/usage/quota/limit" \
        timeout "$1" bunx tsx claude-glm-auto.ts --auto-debug \
        < "$FIFO" > /tmp/cga-out.bin 2>/tmp/cga-err.txt || true
    kill $holder 2>/dev/null || true
    rm -f "$FIFO"
}

python3 tests/mock-quota.py "$PORT" "$STATE" & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 0.5

# ---------------------------------------------------------------- S1 transient
say "S1: transient error at 96% quota -> fast ladder continue, never a limit wait"
set_state "{\"status\":200,\"tokensPct\":96,\"tokensResetMs\":$(( $(NOW_MS) + 3600000 ))}"
FAKE_BANNER='● API Error: Connection closed mid-response. The response above may be incomplete.' \
FAKE_NEXT='-' run_wrapper 6
check "classified transient"        "Transient API error"             "$LOG" 1
check "sent continue (transient)"   'Sending "continue" (transient)' "$LOG" 1
check_absent "no limit wait"        "Limit wait"                      "$LOG"
check "echo landed"                 "❯ continue"                      /tmp/cga-out.bin

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
check "countdown title"             "GLM resumes"                     /tmp/cga-out.bin

# ------------------------------------------------------------- S5 early resume
say "S5: window drops below 95 during the wait -> early resume; bounce -> disabled"
RESET=$(( $(NOW_MS) + 300000 ))
set_state "{\"status\":200,\"tokensPct\":100,\"tokensResetMs\":$RESET}"
( sleep 4; printf '{"status":200,"tokensPct":50,"tokensResetMs":%s}' "$RESET" > "$STATE" ) &
FLIP=$!
FAKE_BANNER="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
FAKE_NEXT="● API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置。][x]" \
  run_wrapper 14
kill $FLIP 2>/dev/null || true
check "early resume fired"          "resuming early"                  "$LOG" 1
check "exactly one early resume"    "resuming early"                  "$LOG" 1
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

# ------------------------------------------------------------------ summary
say "SUMMARY"
printf '  passed: %d, failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
