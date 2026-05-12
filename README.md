# pi-missions

**pi-missions 0.1.0** is an unofficial [pi](https://pi.dev) port inspired by [Factory Missions for Droid](https://factory.ai/news/missions).

It adds long-running, sequential mission orchestration to pi: plan in chat, persist a reviewable mission plan, execute features one at a time in fresh child contexts, validate each feature, and monitor progress in Mission Control.

> Early release: APIs, artifacts, commands, and behavior may change without notice before a stable release.

## What it does

- Chat-first mission planning with an orchestrator skill.
- Persisted mission artifacts under a global `~/.pi/missions/<mission-id>/` store.
- Sequential worker execution, one feature at a time.
- Required worker handoffs and git commits.
- Scrutiny validation against a pre-written validation contract.
- Optional user-testing validator and read-only reviewer fanout.
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
2. Refine scope, assumptions, features, and validation contract in chat.
3. Save the plan with the mission tools when ready.
4. Start execution with `/missions run` or `mission_start_execution` after explicit confirmation.
5. Use `/mission-control` or `/missions status` to monitor progress.
6. If a mission blocks, recover in the main chat; completed work and artifacts are preserved.

## Mission Control

`/mission-control [mission-id]` opens an interactive dashboard for mission progress and controls. It shows mission status, feature progress, current work, recent log events, and bounded child-output tails from `transcript.jsonl` / `stderr.txt`.

Useful keys:

```text
q / esc             Close Mission Control only; execution continues
↑ / ↓ or j / k      Move mission-tree selection
tab / shift-tab     Cycle focused pane
1 / 2 / 3 / 4       Jump to Features / Details / Activity / Child Output pane
pgup / pgdn         Scroll focused pane
ctrl-u / ctrl-d     Half-page scroll focused pane
g / G               Jump to top / bottom of focused pane
i or enter          Toggle inspect mode for the focused pane
r                   Refresh artifacts
p                   Pause after current worker/validator
s                   Start or resume when safe
x                   Cancel current child when supported
c                   Clear completed missions from default visibility
?                   Toggle help
```

Mission Control actions route through deterministic runner commands and preserve confirmation gates for execution-starting or destructive visibility actions.

## Artifact layout

Mission data is stored globally so target repositories do not need `.gitignore` changes and future Mission Control versions can monitor missions across repositories. Set `PI_MISSIONS_HOME` to override the storage root.

```text
~/.pi/missions/<mission-id>/
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
    reviewer/SKILL.md
  runs/<run-id>/
    transcript.jsonl
    stderr.txt
    handoff.json / handoff.md
    validation-report.json / validation-report.md
    user-testing-report.json / user-testing-report.md
    review-report.json / review-report.md
```

## Development checks

Additional contributor validation notes live in [`docs/release-validation.md`](docs/release-validation.md).

```bash
npm run typecheck
npm run validate:f3
npm run validate:f4
npm run validate:f5
npm run validate:f7
npm run validate:f8
npm run validate:f9
npm run validate:f10
```

## Design notes

pi-missions keeps the deterministic layer thin: state files, child process execution, git guardrails, command routing, validation gates, and UI. Planning, decomposition, worker behavior, and validator behavior live primarily in prompts and skills so the system can improve as models improve.

This package is not affiliated with Factory. For the original Factory announcement, see [Factory Missions for Droid](https://factory.ai/news/missions).
