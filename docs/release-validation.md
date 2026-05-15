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

### New mission flow: schemas, optional user-testing, and reviewer advisory routing

1. Confirm `extensions/missions/index.ts` remains runtime bootstrap glue (`import missionsExtension from "./runtime-extension.js"` plus `export default missionsExtension;`).
2. In a disposable branch, run a feature with reviewer fanout and user-testing required in feature metadata.
3. Confirm reviewer runs produce `review-report.json/md` and that scrutiny treats reviewer output as advisory evidence rather than final pass/fail.
4. Confirm scrutiny pass with `userTesting.required: false` marks the feature complete (user-testing is skipped).
5. Confirm scrutiny pass with `userTesting.required: true` moves the feature into user-testing pending/running.
6. Confirm user-testing `pass` marks feature complete; `fail` or `inconclusive` blocks the mission and resets the feature to pending for retry.
7. Corrupt one of `handoff.json`, `validation-report.json`, `user-testing-report.json`, or `review-report.json` in a run directory and confirm clear schema parse/validation failure with field-path details and block metadata.
8. Verify existing mission controls still behave the same (`/missions run`, `/missions status`, Mission Control controls, `mission_start_execution`, and `mission_runner_command`).
9. Integrated Mission Control orchestrator-chat shortcut tuning (including the `o` shortcut) is intentionally deferred; do not treat dedicated orchestrator chat UX changes as part of this validation pass.
