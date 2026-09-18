#!/usr/bin/env bash
# fake-claude.sh — a stand-in `claude` binary for E2E testing claude-glm-auto.
#
# It renders a believable slice of Claude Code's TUI behaviour so the wrapper's
# screen detection has something real to bite on:
#   * sets a window title via OSC (FAKE_TITLE, default "fake claude")
#   * prints FAKE_BANNER lines at startup (e.g. "● API Error: …")
#   * echoes every submitted input line as "❯ <line>" — the same shape the
#     wrapper's stale-marker check matches on
#   * after each input, prints FAKE_NEXT (a script of lines, '-' = nothing)
#     for that round; a FAKE_NEXT of "loop:<text>" repeats <text> every round
#
# Knobs are env vars so the harness can drive scenarios without regenerating
# the script. Exits on the input "quit".
set -u

title="${FAKE_TITLE:-fake claude}"
printf '\x1b]0;%s\x07' "$title"

if [[ -n "${FAKE_BANNER:-}" ]]; then
    printf '%b\n' "$FAKE_BANNER"
fi

next="${FAKE_NEXT:--}"
while IFS= read -r line; do
    [[ "$line" == "quit" ]] && exit 0
    printf '❯ %s\n' "$line"
    if [[ "$next" == loop:* ]]; then
        printf '%b\n' "${next#loop:}"
    elif [[ "$next" != "-" ]]; then
        printf '%b\n' "$next"
        next="-"
    fi
done
exit 0
