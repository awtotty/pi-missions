# pi-missions

**pi-missions 0.1.0** is an unofficial [pi](https://pi.dev) port inspired by [Factory Missions for Droid](https://factory.ai/news/missions).

It adds long-running, sequential mission orchestration to pi: plan in chat, persist a reviewable milestone-based mission plan, execute milestone features one at a time in fresh child contexts, run validation at milestone boundaries, and monitor progress in Mission Control.

> Early release: APIs, artifacts, commands, and behavior may change without notice before a stable release.

## What it does

- Chat-first mission planning with an orchestrator skill.
- Persisted mission artifacts under a global `~/.pi/missions/<mission-id>/` store.
- Milestone-canonical planning where runtime feature state lives under `milestones[].features`.
- Sequential worker execution, one milestone feature at a time.
- Required worker handoffs and git commits.
- Milestone-boundary scrutiny validation against a pre-written validation contract.
- Optional milestone-boundary user-testing validation using a distinct validator skill.
- Interactive Mission Control dashboard via `/mission-control`.
- Compact mission status/footer indicator.
- Per-role model defaults for orchestrator, worker, and validator.

Parallel write workers are intentionally out of scope. The mission runner optimizes for correctness and recoverability over raw concurrency.

## Install

From npm, once published:

```bash
pi install pi-missions
```

For local development/testing:

```bash
pi install -l /workspace/pi-missions
# or one-off:
pi -e /workspace/pi-missions
```

After local edits, use `/reload` inside pi.

## Commands

```text
/missions [goal]           Start chat-first mission planning
/missions new [goal]       Alias for /missions [goal]
/missions run [id]         Start or resume a persisted mission
/missions resume [id]      Resume a paused mission
/missions status [id]      Show mission status
/mission-control [id]      Open Mission Control
/missions list             List missions
/missions clear            Hide completed missions from default visibility
/missions models           Inspect role model defaults
/missions models <role> <model>
                           Set a role model default
/mission ...               Alias for /missions
```

## Typical flow

1. Run `/missions <goal>`.
2. Refine scope, assumptions, milestones, nested features, and validation contract in chat.
3. Save the plan with the mission tools when ready.
4. Start execution with `/missions run` or `mission_start_execution` after explicit confirmation.
5. Use `/mission-control` or `/missions status` to monitor progress.
6. If milestone validation fails, the runner blocks and hands control to the mission's dedicated orchestrator session; completed work and artifacts are preserved while the orchestrator decides whether to revise the plan and resume. Main chat remains the human command/override channel.


## Execution model

The normal runner loop has three roles: orchestrator, worker, and validator. Workers implement individual features and produce commits plus handoff artifacts. After all runnable features in a milestone are complete or skipped, the runner starts milestone-boundary validators: scrutiny first via `skills/validator-scrutiny/SKILL.md`, then optional user-testing via `skills/validator-user-testing/SKILL.md` when the milestone requests it. There is no standalone reviewer role in the deterministic execution loop; scrutiny validators own adversarial code review.

Child agents produce artifacts, but the runner/orchestrator own mission metadata transitions. A milestone validation failure persists the report, increments that milestone's independent failure counter, blocks the mission, and hands recovery to the mission's dedicated orchestrator session instead of automatically choosing fix work. The default effective validation failure limit is 5 per milestone unless mission/milestone metadata overrides it.

## Mission Control

`/mission-control [mission-id]` opens a read-only observability overlay. Without an id, it shows a global multi-mission overview across the mission store, including missions from different repositories and worktrees. With an id, it opens directly to that mission's detail view.

The overview uses stable sections in this order: **Blocked / Failed**, **Running**, **Paused**, **Planned**, and **Completed**. Each mission card shows the title/status, mission id plus repository/worktree label, current task, completed/total progress bar, and update time when available.

Detail view repeats the same mission summary at the top, then shows the most relevant read-only output below it: active transcript/stderr tails for running missions, current block artifacts for blocked/failed missions, latest milestone validation or completion handoff for completed missions, and objective/next-step context for planned or paused missions.

Useful keys:

```text
q / esc             Close Mission Control from overview; execution continues
↑ / ↓ or j / k      Move mission selection in overview; scroll output in detail
enter               Open the selected mission detail from overview
b / esc             Return from detail to overview when not opened for a specific id
r                   Refresh artifacts and re-render
?                   Toggle help
g / G               Jump to top / bottom of detail output
```

Mission Control v1 is intentionally read-only. Start, resume, pause, cancel, clear, recovery, and plan changes remain in main chat and deterministic tools such as `/missions ...`, `mission_start_execution`, and `mission_runner_command`. See [`docs/mission-control.md`](docs/mission-control.md) for the full multi-mission Mission Control guide.

## Artifact layout

Mission data is stored globally so target repositories do not need `.gitignore` changes and future Mission Control versions can monitor missions across repositories. Set `PI_MISSIONS_HOME` to override the storage root.

```text
~/.pi/missions/<mission-id>/
  mission.json              # milestone-canonical runtime state; features live under milestones[].features
  event-log.jsonl
  plan/
    objective.md
    features.json           # derived ordered feature list for review/compatibility, not runtime state
    validation-contract.json
    validation-contract.md
  skills/
    worker/SKILL.md
    validator-scrutiny/SKILL.md
    validator-user-testing/SKILL.md
  recovery-packets/
    <timestamp>-<run-id>.json / .md   # runtime orchestrator recovery handoff contract
  runs/<run-id>/
    transcript.jsonl
    stderr.txt
    handoff.json / handoff.md
    validation-report.json / validation-report.md
    user-testing-report.json / user-testing-report.md
```

Recovery packet shape and authority boundaries are documented in [`docs/runtime-orchestrator-recovery-artifacts.md`](docs/runtime-orchestrator-recovery-artifacts.md).

## Development checks

Additional contributor validation notes live in [`docs/release-validation.md`](docs/release-validation.md). The default contributor workflow is:

```bash
npm run typecheck       # TypeScript compile-time checks without emitting files
npm test                # Vitest unit/behavior tests
npm run validate        # Mission regression harnesses under scripts/
npm run build           # Emit the publishable extension to dist/
npm run check           # Full local gate: typecheck, tests, validation, build
```

Run focused validation scripts while iterating on a specific area, then run `npm run check` before handing work off or cutting a package. `npm run validate:mission-control-readonly` is the Mission Control read-only regression harness for multi-mission sections, overview/detail navigation, output rendering, docs, and absence of overlay mutation controls.

The package manifest loads the built extension entrypoint (`dist/missions/index.js`) for publication. Local source edits should still preserve the public commands, tools, milestone-canonical mission artifact layout, and Mission Control interaction model documented above.

## Design notes

pi-missions keeps the deterministic layer thin: state files, child process execution, git guardrails, command routing, milestone validation gates, and UI. Planning, decomposition, worker behavior, and validator behavior live primarily in prompts and skills so the system can improve as models improve.

This package is not affiliated with Factory. For the original Factory announcement, see [Factory Missions for Droid](https://factory.ai/news/missions).
