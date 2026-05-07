# pi-missions

Long-running, sequential mission orchestration for [pi](https://pi.dev).

This is an early prototype inspired by Factory Missions, with a different design goal: keep most orchestration intelligence in prompts and skills so better models improve mission behavior without TypeScript changes.

## Current scope

- `/missions` and `/mission` commands
- interactive planning in the current pi session
- `mission_write_plan` tool for persisting planning drafts
- `mission_approve_plan` and `mission_start_execution` tools with explicit user confirmation
- mission artifacts under `.pi/missions/<mission-id>/`
- generated validation contract and mission-specific skills
- sequential worker execution, one fresh child process per feature
- required worker handoff files
- required git commit per completed feature
- milestone validator child process
- status widget and `/missions status`

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

The current validation check is TypeScript type checking:

```bash
npm run typecheck
```

## Commands

```text
/missions new [goal]       Start interactive planning for a new mission
/missions approve [id]     Approve the persisted plan and unlock execution
/missions run [id]         Run or resume a mission sequentially
/missions status [id]      Show mission status
/missions list             List missions
/mission ...               Alias for /missions
```

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

The mission schema has separate model slots:

```json
{
  "models": {
    "orchestrator": "default",
    "worker": "default",
    "validator": "default"
  }
}
```

For now these default to pi's current default model. Later this should become configurable globally and per mission.

## Design notes

- The extension is the durable runtime: commands, child process spawning, state files, git guardrails, and UI status.
- The skills are the brains: planning, decomposition, validation contracts, worker procedures, and adversarial validation.
- Workers get fresh context per feature and must produce structured handoffs.
- Validators get fresh context and validate against the pre-written contract.
