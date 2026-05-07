# pi-missions

Long-running, sequential mission orchestration for [pi](https://pi.dev).

This is an early prototype inspired by Factory Missions, with a different design goal: keep most orchestration intelligence in prompts and skills so better models improve mission behavior without TypeScript changes.

## Current scope

- `/missions` and `/mission` commands that load the orchestrator into the current conversation
- chat-first brainstorming and plan refinement in the current pi session
- lazy `mission_write_plan` persistence after the orchestrator shows a reviewable plan in chat
- persisted plans are echoed as bounded, reviewable summaries instead of hidden-only artifact writes
- `mission_start_execution` tool with explicit user confirmation as the single start/run gate
- mission artifacts under `.pi/missions/<mission-id>/`
- generated validation contract and mission-specific skills
- sequential worker execution, one fresh child process per feature
- required worker handoff files
- required git commit per completed feature
- milestone validator child process
- dedicated Mission Control dashboard/control TUI (`/mission-control`) and `/missions status`
- compact mission footer/status indicator via `ctx.ui.setStatus("missions", ...)` instead of the old rich always-on widget

Parallel write agents are intentionally out of scope. Future read-only reviewer/validator fanout can be added safely later.

## Install for local testing

From any target repo:

```bash
pi install -l /workspace/pi-missions
# or for one-off testing:
pi -e /workspace/pi-missions
```

After edits, use `/reload` in pi.

## Run tests

The current automated validation check is TypeScript type checking:

```bash
npm run typecheck
```

## Manual validation scenarios

Use these scenarios for release-style checks of mission flows. They complement, but do not replace, the automated `npm run typecheck` validation command.

### Block injection and recovery context

1. Start or use a small test mission with at least one feature.
2. Force a worker or validator block, for example by temporarily making a feature worker produce a non-`complete` handoff in a disposable checkout or by using an intentionally failing validation contract.
3. Run `/missions run <mission-id>`.
4. Confirm the main chat receives a visible `[MISSION BLOCKED - RECOVERY CONTEXT]` follow-up that includes the mission id, failed feature or milestone, run id, run directory, exit code/status, artifact paths when present, and suggested inspection steps.
5. Inspect `.pi/missions/<mission-id>/mission.json` and `event-log.jsonl` and confirm `latestBlock`/`mission_block_recorded` metadata captures the reason category, failed item, run id, artifact paths, and timestamp without breaking the existing mission schema.

### Code-review validator behavior

1. Complete a milestone containing one or more feature commits and handoffs.
2. Run `/missions run <mission-id>` until milestone validation starts.
3. Inspect the validator run prompt/transcript and `validation-report.md`.
4. Confirm the validator reviews each completed feature's commit and handoff, evaluates diffs, tests, edge cases, regressions, and procedure compliance, and can report code-review defects or procedure findings separately from validation-contract assertion results.

### Global role model defaults

1. Run `/missions models` and note the settings file and current `orchestrator`, `worker`, and `validator` defaults.
2. Set a default with `/missions models <role> <provider/model-id>`; use `/missions models <role> default` to restore fallback behavior.
3. Create a new mission with `/missions new <goal>` and confirm its `models` object remains compatible while inheriting configured global defaults.
4. For a non-`default` orchestrator model, start `/missions` or `/missions new` and confirm pi applies the model before the kickoff message, or shows a clear warning if the reference is invalid or credentials are unavailable.
5. During execution, confirm worker and validator child runs resolve per-mission `default` slots through the current global defaults.

### Mission Control status and footer indicator

1. Run `/missions status <mission-id>` while a mission is planned, running, blocked, and complete.
2. Confirm the status output includes progress, mission directory, current or last run id, run item, run artifact path, blocked reason and block artifacts when present, and a next suggested action.
3. Confirm the `mission_status` tool returns the same summary semantics as `/missions status`.
4. Observe the footer/status indicator during execution and after `/missions clear`; it should remain compact (`ctx.ui.setStatus("missions", ...)`) while the old rich always-on mission widget stays hidden and no stale completed-mission widget appears.

## Commands

```text
/missions [goal]           Load the orchestrator into the current conversation
/missions new [goal]       Alias for /missions [goal]
/missions run [id]         Start or resume a persisted mission sequentially
/missions status [id]      Show mission status
/mission-control [id]      Open the Mission Control dashboard and controls
/missions list             List missions
/missions models           Inspect global role model defaults
/missions models <role> <model>
                           Set a global role model default
/mission ...               Alias for /missions
```

`/missions` is a chat-first workflow: it loads the mission orchestrator skill into the current conversation, then brainstorming, scoping, assumptions, milestones, features, and validation planning happen in chat. When a plan is persisted, the assistant should show the plan content for review and `mission_write_plan` returns a concise visible summary with artifact locations. Persisted plans are directly runnable; `/missions run` or `mission_start_execution` is the single explicit confirmation gate before implementation begins.

## Mission Control

`/mission-control [mission-id]` opens a dedicated Mission Control dashboard in interactive pi sessions. It monitors mission artifacts and also offers a small, explicit control surface for safe mission operations. In non-interactive/RPC/headless contexts, use `/missions status` or the `mission_status` tool instead.

When opened without an id, Mission Control prefers the active mission. If there is no active mission, it shows recent visible missions or an empty state. The dashboard includes a mission header, progress bar, current-work panel, milestone-grouped feature panel, progress log, child output panel, and footer controls. The child output panel shows bounded tails from the current or most recent run's `transcript.jsonl` and `stderr.txt`; it never depends on reading an unbounded transcript into memory.

The layout is responsive. Wide terminals show side-by-side dashboard panels, medium and narrow terminals stack sections in priority order, and very narrow terminals use compact status/footer text. Rendering uses width-aware clipping/truncation so dashboard lines remain within terminal width.

Mission execution auto-opens Mission Control in interactive mode when started or resumed through `/missions run` or `mission_start_execution`. Closing Mission Control with `q` or `esc` only closes the UI and returns to the normal session; it does not stop worker/validator execution or change mission state.

Keyboard controls:

```text
q / esc        Close Mission Control only; execution continues
↑ / ↓ or j / k Move selection
tab            Cycle focus hint between features and progress log
r              Refresh from mission artifacts
p              Request pause-after-current; does not kill the active worker/validator
s              Start or resume mission execution when safe; confirmation required
c              Hide completed missions from default visibility; confirmation required
?              Toggle help
```

Safety boundaries:

- Mutating actions use explicit shortcuts, notifications, and audit events; execution-starting or destructive visibility actions require confirmation.
- Pause is pause-after-current: it records a durable request while the mission keeps running until the current worker/validator exits, then the run loop transitions the mission to paused before launching another unit.
- Start/resume is refused while a mission is already running or while a pause request is pending for an in-flight run, preventing overlapping execution loops for the same mission.
- Clear completed missions hides them from default Mission Control visibility without deleting artifacts or changing their completed status.

Mission Control replaces the old rich always-on active mission widget. The extension still keeps a minimal `ctx.ui.setStatus("missions", ...)` footer/status output for compact visibility, but no longer renders a persistent rich mission widget in every session.

## Artifact layout

```text
.pi/missions/<mission-id>/
  mission.json
  event-log.jsonl
  plan/
    objective.md
    features.json
    validation-contract.json
    validation-contract.md
  skills/
    worker/SKILL.md
    validator-scrutiny/SKILL.md
    validator-user-testing/SKILL.md
  runs/
    <run-id>/
      transcript.jsonl
      stderr.txt
      handoff.json
      handoff.md
      validation-report.json
      validation-report.md
```

## Role model defaults

Missions use separate model slots for each role:

```json
{
  "models": {
    "orchestrator": "default",
    "worker": "default",
    "validator": "default"
  }
}
```

Global defaults are configured with `/missions models`:

```text
/missions models                         Show current global defaults and settings file
/missions models orchestrator <model>    Set the planner/orchestrator default
/missions models worker <model>          Set the feature worker default
/missions models validator <model>       Set the milestone validator default
/missions models set <role> <model>      Equivalent explicit set form
```

The supported roles are `orchestrator`, `worker`, and `validator`. Use `default` as a model value when a role should fall back to pi's current default model.

The defaults are stored in `.pi/missions/settings.json` for the target repository. New missions start from those global defaults, while the existing per-mission `models` object remains valid for compatibility. During execution, a per-mission role value other than `default` is used directly; a per-mission `default` slot is resolved through the current global default for that role.

When `/missions` or `/missions new` loads the current-session orchestrator, a non-`default` global `orchestrator` value is resolved against pi's model registry and applied to the active session before the kickoff message is sent. Use canonical `provider/model-id` references when possible. If the model cannot be found or credentials are unavailable, pi leaves the current model unchanged and shows a warning.

## Design notes

- The extension is the durable runtime: commands, child process spawning, state files, git guardrails, and UI status.
- The skills are the brains: planning, decomposition, validation contracts, worker procedures, and adversarial validation.
- Workers get fresh context per feature and must produce structured handoffs.
- Validators get fresh context and validate against the pre-written contract.

### Mission Control UI concurrency

`ctx.ui.custom()` is interactive-only: RPC/headless mode returns no custom UI, and interactive mode returns a Promise that resolves when the component calls `done()`/closes. Because that Promise represents the UI lifetime, mission execution must not await an auto-opened Mission Control view before starting or continuing worker/validator execution.

The chosen architecture is therefore:

1. Keep `runMission()` as the durable execution owner for sequential worker and validator child processes.
2. Auto-open Mission Control from execution entrypoints in interactive mode with a fire-and-forget call.
3. Make Mission Control read mission artifacts (`mission.json`, `event-log.jsonl`, run handoffs/reports, bounded transcript/stderr tails) and poll/refresh independently.
4. Keep Mission Control actions explicit and routed through audited command handlers; confirmation gates are required for starting/resuming execution and clearing completed-mission visibility.
5. Treat `q`/`esc` as UI disposal only; closing Mission Control must not abort `ctx.signal`, kill child processes, or alter mission state.

This preserves chat-first planning, lets Mission Control provide safe operational controls, and ensures closing the dashboard does not stop execution.
