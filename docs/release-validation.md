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

The first runtime split has extracted low-risk pure helpers into `extensions/missions/core/`:

- `paths.ts` for mission root/id/path helpers.
- `settings.ts` for role model defaults and settings parsing.
- `json.ts` for JSON file IO helpers.
- `events.ts` for event-log append/tail helpers.

Future modularization remains deliberately scoped out of this foundation pass. High-value next seams are artifact schema/handoff modules, runner command/execution/lock/recovery modules, Mission Control UI panes/input/widget modules, and command/tool registration modules. Preserve current command names, tool names, and artifact layout while extracting those seams.

### New mission flow: milestone validation and scrutiny-owned code review

1. Confirm `extensions/missions/index.ts` remains runtime bootstrap glue (`import missionsExtension from "./runtime-extension.js"` plus `export default missionsExtension;`).
2. In a disposable branch, run a milestone with multiple worker features.
3. Confirm workers complete feature slices before any milestone validator starts.
4. Confirm scrutiny validators own code review without standalone reviewer fanout.
5. Confirm scrutiny pass without milestone user-testing marks the milestone complete and advances.
6. Confirm configured milestone user-testing runs as validator mode `user-testing` with `skills/validator-user-testing/SKILL.md` only after scrutiny passes.
7. Confirm scrutiny or user-testing `fail`/`inconclusive` blocks the mission for orchestrator intervention, increments only that milestone's failure counter, and does not automatically choose fix work. The default effective failure limit is 5 per milestone unless overridden.
8. Corrupt one of `handoff.json`, `validation-report.json`, or `user-testing-report.json` in a run directory and confirm clear schema parse/validation failure with field-path details and block metadata.
9. Verify existing mission controls still behave the same (`/missions run`, `/missions status`, Mission Control controls, `mission_start_execution`, and `mission_runner_command`).
10. Integrated Mission Control orchestrator-chat shortcut tuning (including the `o` shortcut) is intentionally deferred; do not treat dedicated orchestrator chat UX changes as part of this validation pass.
