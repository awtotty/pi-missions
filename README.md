# pi-missions

**pi-missions 0.1.0** is an early-development [pi](https://pi.dev) extension for long-running, milestone-based coding missions.

It is inspired by [Factory Missions for Droid](https://factory.ai/news/missions): plan carefully in chat, approve execution, let scoped workers make progress through git-backed handoffs, validate at milestone boundaries, and monitor status in Mission Control.

> **Independence note:** pi-missions is not affiliated with Factory and is not a copy or port of Factory Missions. It was built independently, without access to Factory Missions source code, and uses only public product concepts as inspiration.
>
> **v0.1.0 note:** this project is active development software. Commands, APIs, artifact schemas, and behavior may change before a stable release.

## What it does

- Plans missions in chat with the `mission-plan` skill.
- Saves milestone-canonical mission artifacts under `~/.pi/missions/<mission-id>/`.
- Runs one worker feature at a time in fresh child contexts.
- Requires worker handoffs and git commits.
- Validates at milestone boundaries with scrutiny and optional user-testing validators.
- Routes recoverable blocks to a dedicated runtime `mission-orchestrator` session.
- Shows read-only mission status in `/mission-control` and the compact footer.

pi-missions intentionally favors sequential writes, inspectable artifacts, and recoverability over parallel implementation speed.

## Install

From npm, once published:

```bash
pi install pi-missions
```

For local development:

```bash
pi install -l /workspace/pi-missions
# or one-off:
pi -e /workspace/pi-missions
```

After local edits, run `npm run build` and restart pi. `/reload` may not fully refresh extension runtime code.

## Quick start

```text
/missions build a settings UI for project X
```

Typical flow:

1. Plan in the current/main chat session: goal, assumptions, non-goals, milestones, features, and validation contract.
2. Review the saved plan.
3. Start execution with `/missions run` or `mission_start_execution` after explicit confirmation.
4. Monitor with `/missions status` or `/mission-control`.
5. If a worker or validator blocks, the runner writes recovery artifacts and triggers the mission's runtime orchestrator session.
6. Intervene from main chat only when product decisions, credentials, tradeoffs, or explicit overrides are needed.

## Commands

```text
/missions [goal]             Start chat-first mission planning
/missions new [goal]         Alias for /missions [goal]
/missions run [id]           Start or resume a persisted mission
/missions resume [id]        Resume a paused mission
/missions status [id]        Show mission status
/missions list               List missions
/missions clear              Hide completed missions from default visibility
/missions models             Inspect role model defaults
/missions models <role> <model>
                             Set a role model default
/mission-control [id]        Open read-only Mission Control
/mission ...                 Alias for /missions
```

## Execution model

The deterministic runner has three roles:

- **planner** (`mission-plan` skill): collaborates with the user before execution starts;
- **worker**: implements one feature, commits changes, and writes a handoff;
- **validator**: runs milestone-boundary scrutiny or user-testing validation.

The runtime `mission-orchestrator` is event-driven. It runs in the dedicated runtime orchestrator session after recoverable blocks such as validation failure, worker block, no-runnable-work, retry-limit exceeded, or ambiguous/stale state, and runs only for that event. It may repair mission metadata/control state through mission tools/APIs, resume, ask the user, rerun validation when safe, or leave the mission blocked. It must not edit repository implementation code by default.

Mission Control is read-only observability. Start, pause, resume, cancel, recovery, and plan changes stay in chat/tools/runtime orchestration. Main chat remains the human command/override channel.

## Mission Control

Open Mission Control with:

```text
/mission-control [mission-id]
```

Without an id, it shows a multi-mission overview grouped by **Blocked / Failed**, **Running**, **Paused**, **Planned**, and **Completed**. With an id, it opens that mission's detail view.

Useful keys:

```text
q / esc             Close from overview; execution continues
↑ / ↓ or j / k      Move selection or scroll detail output
enter               Open selected mission detail
b / esc             Return from detail to overview
r                   Refresh
?                   Toggle help
g / G               Jump to top / bottom
```

Full guide: [`docs/mission-control.md`](docs/mission-control.md).

## Artifact layout

Mission data is global so repositories do not need `.gitignore` changes and Mission Control can monitor work across repos. Set `PI_MISSIONS_HOME` to override the storage root.

```text
~/.pi/missions/<mission-id>/
  mission.json              # runtime state; features live under milestones[].features
  event-log.jsonl
  plan/
    objective.md
    features.json           # derived review artifact, not runtime state
    validation-contract.json
    validation-contract.md
  skills/
    worker/SKILL.md
    validator-scrutiny/SKILL.md
    validator-user-testing/SKILL.md
  recovery-packets/
    <timestamp>-<run-id>.json / .md
  runs/<run-id>/
    transcript.jsonl
    stderr.txt
    handoff.json / handoff.md
    validation-report.json / validation-report.md
    user-testing-report.json / user-testing-report.md
```

Recovery packet details: [`docs/runtime-orchestrator-recovery-artifacts.md`](docs/runtime-orchestrator-recovery-artifacts.md).

## Roadmap snapshot

Recently completed:

- milestone-canonical mission schema;
- milestone-level deterministic run loop;
- read-only multi-mission Mission Control;
- event-driven runtime orchestrator recovery;
- split `mission-plan` from runtime `mission-orchestrator`;
- release-critical runtime modularization.

Next:

- release docs/package validation and npm publish;
- planning readiness checklist and run estimates;
- user config for role models and validation failure caps;
- token/cost tracking and mission budgets;
- headless/remote execution and portable mission bundles.

Full roadmap: [`docs/roadmap.md`](docs/roadmap.md).

## Development

```bash
npm run typecheck       # TypeScript checks
npm test                # Vitest tests
npm run validate        # Mission regression harnesses
npm run build           # Compile publishable JS to dist/
npm run check           # Full local gate
npm pack --dry-run      # Package contents smoke check
```

Release notes and manual validation: [`docs/release-validation.md`](docs/release-validation.md).

The package manifest loads the built extension entrypoint (`dist/missions/index.js`). Preserve public commands, tools, artifact paths, and the read-only Mission Control model when changing runtime code.

## License and attribution

MIT. pi-missions is an independent pi extension inspired by the public [Factory Missions for Droid](https://factory.ai/news/missions) announcement. It is not affiliated with Factory.
