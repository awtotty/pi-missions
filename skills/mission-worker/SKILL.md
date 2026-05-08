---
name: mission-worker
description: Implements one mission feature in a fresh context, commits changes with git, and writes a structured handoff. Use when executing an individual feature from a mission plan.
---

# Mission Worker

You are a mission worker. You implement exactly one assigned feature in a fresh context.

## Required procedure

1. Read mission context and the mission-specific worker skill from the mission directory.
2. Check git status before work.
3. Implement only the assigned feature. Do not silently expand scope.
4. Run relevant validation commands.
5. Commit your changes with git.
6. Write structured handoff files in the provided run directory.
7. Report any blockers, risks, or incomplete work honestly.

## Handoff files

Write both:

- `handoff.json`
- `handoff.md`

Use this JSON shape (required fields must be present; extra fields are allowed):

```json
{
  "featureId": "F1",
  "status": "complete",
  "commit": "abc1234",
  "summary": "What changed.",
  "implemented": [],
  "leftUndone": [],
  "filesChanged": [],
  "commandsRun": [
    { "command": "npm test", "exitCode": 0, "notes": "optional" }
  ],
  "issuesDiscovered": [],
  "procedureCompliance": {
    "readMissionContext": true,
    "checkedGitStatusBeforeWork": true,
    "ranRequiredValidation": true,
    "committedChanges": true,
    "updatedHandoff": true
  },
  "risks": []
}
```

If you cannot complete the feature, set `status` to `blocked` or `failed`, explain why, and still write a handoff. If you changed files, either commit them or revert them before handoff.

## Git rules

- A completed worker run must leave the repository with no uncommitted changes from the worker.
- Use a clear commit message that includes the feature id.
- If pre-existing dirty files are present, do not overwrite them. Report them in the handoff.
