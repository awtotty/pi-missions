# Release validation notes

These checks are maintained for contributors and automation. They are intentionally kept out of the short npm README.

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
