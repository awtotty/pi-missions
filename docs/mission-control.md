# Mission Control

Mission Control is the read-only observability overlay for pi-missions. Open it with:

```text
/mission-control [mission-id]
```

Without an id, Mission Control shows a global multi-mission overview across the mission store, including missions from different repositories and worktrees. With an id, it opens directly to that mission's detail view.

Mission Control is read-only observability. Start, resume, pause, cancel, clear, recovery, and plan changes route through `/missions ...`, `mission_start_execution`, `mission_runner_command`, the dedicated runtime orchestrator session, or main chat human override. Workers complete feature slices; scrutiny and user-testing validators run at milestone boundaries under the validator role, with user testing required by default unless explicitly disabled for a milestone. A milestone validation failure or other recoverable block writes recovery artifacts and dispatches an event to the mission's dedicated runtime orchestrator session instead of automatically choosing fix work.

## Overview sections

The overview is grouped in this stable order:

1. **Blocked / Failed** — missions that currently need intervention.
2. **Running** — missions with active execution.
3. **Paused** — missions waiting after a pause request or safe stop.
4. **Planned** — saved plans that have not started yet.
5. **Completed** — finished missions that have not been cleared from default visibility.

Each mission card shows:

- mission title and status;
- mission id and repository/worktree label;
- current task derived from the active run, current feature, or next pending work;
- completed/total feature progress with a progress bar;
- latest update time when available.

## Detail view

Detail view repeats the same mission summary at the top, then shows the most relevant read-only output below it:

- active transcript and stderr tails for running missions;
- current block or failed-run artifacts for blocked/failed missions;
- latest milestone validation or completion handoff for completed missions;
- objective or next-step context for planned and paused missions.

The output pane is bounded and scrollable so large transcripts do not take over the terminal.

## Recovery visibility

Mission Control can show current block artifacts, failed run output, and recovery packet paths, but it is not the recovery executor. Opening or refreshing Mission Control does not trigger recovery, mutate mission metadata/control state, resume a runner, or ask a worker to make code changes.

The runtime orchestrator is event-driven and turn-based. The deterministic runner triggers it after recoverable blocks, and that dedicated session may use mission tools/APIs to repair mission metadata/control state. Main chat remains the human command/override channel when the user needs to redirect, answer a question, or override the runtime recovery path.

## Keys

```text
q / esc             Close Mission Control from overview; execution continues
↑ / ↓ or j / k      Move mission selection in overview; scroll output in detail
enter               Open the selected mission detail from overview
b / esc             Return from detail to overview (when not opened for a specific id)
r                   Refresh artifacts and re-render
?                   Toggle help
g / G               Jump to top / bottom of detail output
```

Mission Control is intentionally read-only. It does not expose start, resume, pause, cancel, clear, recovery, or plan-edit controls in the overlay.
