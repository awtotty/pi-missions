# Release validation notes

These checks are maintained for contributors and automation. The README lists the short development workflow; this document captures the release-oriented gate and manual regression notes.

## Contributor and release gate

Use focused commands while iterating, then run the full gate before handoff or release:

```bash
npm run typecheck       # TypeScript compile-time checks without emitting files
npm test                # Vitest unit/behavior tests
npm run validate        # All mission regression harnesses under scripts/
npm run build           # Compile publishable JavaScript into dist/
npm run check           # typecheck + tests + validation + build
npm pack --dry-run      # Optional package contents smoke check
```

Publication loads the built extension entrypoint declared in `package.json` (`dist/missions/index.js`). Keep `extensions/missions/index.ts` as source bootstrap glue and verify that `npm run build` updates the corresponding `dist/` output before packaging.

## Current modularization seam

The release-critical runtime split now has focused modules around the highest-risk runtime responsibilities while preserving public commands, tool names, and mission artifact paths:

- `extensions/missions/core/` contains shared pure/runtime-adjacent helpers such as mission paths, JSON IO, settings, event logs, session records, and the Mission Control view model.
- `extensions/missions/runner/locks.ts` owns runner lock paths, stale-lock detection, acquisition, heartbeat updates, and release helpers.
- `extensions/missions/runner/recovery.ts` owns recovery packet writing, runtime orchestrator recovery prompt construction, block formatting, hidden `mission-orchestrator` skill injection, and recovery dispatch helpers.
- `extensions/missions/status/formatting.ts` owns `/missions status` and `mission_status` text formatting helpers.
- `extensions/missions/ui/mission-control.ts` owns Mission Control rendering/input glue and read-only overview/detail behavior.

`extensions/missions/runtime-extension.ts` remains the compatibility entrypoint and command/tool registration coordinator for this release. Post-release cleanup should continue extracting artifact schema/handoff helpers, runner command/execution state transitions, and command/tool registration seams from that file without changing public command names, tool names, or the mission artifact layout.

## Runtime orchestrator recovery loop

Run the deterministic harness when changing runner recovery, session routing, recovery prompts, Mission Control recovery visibility, or orchestrator skills:

```bash
npm run validate:runtime-recovery-loop
```

Release validation should confirm:

1. Planning still happens in the current/main chat session before `/missions run` or `mission_start_execution` starts workers.
2. Validation failure, worker block, no-runnable-work, retry-limit exceeded, and ambiguous/stale state recovery routes to the mission's dedicated runtime orchestrator session when session controls are available.
3. The runtime orchestrator is event-driven and turn-based: it runs only after a runner event or explicit user redirect, never as an always-on background worker while normal workers/validators run.
4. Recovery packets and prompts allow the runtime orchestrator to mutate mission metadata/control state through mission tools/APIs, while forbidding repository implementation edits by default.
5. Main chat remains the human command/override channel and receives only display/fallback recovery context when dedicated session dispatch is unavailable.
6. Mission Control remains read-only observability: it may display block/recovery artifacts, but opening or refreshing it must not start, resume, pause, cancel, clear, edit plans, trigger recovery, or mutate mission state.

### New mission flow: milestone validation and scrutiny-owned code review

1. Confirm `extensions/missions/index.ts` remains runtime bootstrap glue (`import missionsExtension from "./runtime-extension.js"` plus `export default missionsExtension;`).
2. In a disposable branch, run a milestone with multiple worker features.
3. Confirm workers complete feature slices before any milestone validator starts.
4. Confirm scrutiny validators own code review without standalone reviewer fanout.
5. Confirm scrutiny pass without milestone user-testing marks the milestone complete and advances.
6. Confirm configured milestone user-testing runs as validator mode `user-testing` with `skills/validator-user-testing/SKILL.md` only after scrutiny passes.
7. Confirm scrutiny or user-testing `fail`/`inconclusive` blocks the mission for dedicated runtime orchestrator intervention, increments only that milestone's failure counter, and does not automatically choose fix work. The default effective failure limit is 5 per milestone unless overridden.
8. Corrupt one of `handoff.json`, `validation-report.json`, or `user-testing-report.json` in a run directory and confirm clear schema parse/validation failure with field-path details and block metadata.
9. Verify existing mission controls still behave the same (`/missions run`, `/missions status`, Mission Control read-only views, `mission_start_execution`, and `mission_runner_command`).
10. Integrated Mission Control orchestrator-chat shortcut tuning (including the `o` shortcut) is intentionally deferred; do not treat dedicated orchestrator chat UX changes as part of this validation pass.
