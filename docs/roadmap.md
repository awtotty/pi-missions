# pi-missions roadmap

This roadmap describes how `pi-missions` should evolve from the current early extension into a production-ready, Factory Missions-aligned pi extension.

`pi-missions` is not trying to become GSD. GSD is useful as a reference for packaging, tests, and release discipline, but the product target is Factory Missions for Droid: a planning-heavy, long-running orchestration system where a user approves scope, monitors execution in Mission Control, and intervenes as a project manager while workers and validators make progress through git-backed handoffs.

## North star

A user should be able to run:

```text
/missions build <large goal>
```

Then:

1. Collaborate with an orchestrator to produce a high-quality plan.
2. Review features, milestones, skills, validation strategy, risks, assumptions, and estimated run cost.
3. Explicitly approve execution.
4. Enter Mission Control.
5. Watch workers execute scoped units of work in fresh contexts.
6. Watch validators verify work at the right cadence.
7. Redirect, pause, unblock, or replan through the orchestrator when needed.
8. Come back hours or days later to a coherent artifact trail, clean git history, and either completed work or an actionable blocked state.

## Current state

The extension already has a strong foundation:

- `/missions`, `/mission`, `/mission-control`, and `/mission-orchestrator` commands.
- Mission planning through an orchestrator skill.
- Persisted artifacts under `~/.pi/missions/<mission-id>/`.
- Sequential feature execution through fresh child sessions.
- Required worker handoffs and git commits.
- Scrutiny validation and optional user-testing/reviewer flows.
- Mission Control panes for features, details, activity, and child output.
- Start/resume/pause/cancel control routing.
- Runner lock/ownership artifacts and recovery-oriented state.
- Per-role model defaults.
- Typecheck and custom validation scripts.

The main gaps are not conceptual. They are about Factory alignment, robustness, product polish, and release engineering.

## Completed roadmap work

### Foundation mission completed: `mission-roadmap-p0-foundation`

The first roadmap mission completed successfully and established the baseline needed for larger changes.

Completed commits:

- `d653117` — F1 add build/test/check infrastructure.
- `4dcc2f2` — F2 add schema foundation tests.
- `114380d` — F2 cover invalid artifact report schemas.
- `817bb42` — F3 extract runtime helper modules.
- `144a33d` — F4 document contributor workflow.

Outcomes:

- Added production-oriented `build`, `validate`, and `check` scripts.
- Added Vitest-based tests that run without a live pi session.
- Added initial artifact validation coverage.
- Extracted low-risk runtime helper modules under `extensions/missions/core/`.
- Updated contributor workflow docs.

Important observations from dogfooding:

- Background mission execution while the main chat remains usable is a strong UX pattern and should be preserved as a core invariant.
- Main-chat intervention works well as the practical “chat with orchestrator” experience: the user can ask for status, recovery, pause/resume, or plan changes while workers continue in the background.
- Mission status and Mission Control can surface stale block information after recovery; stale status indicators are a high-priority quality issue.
- Mission Control is currently too buggy and unhelpful to be the primary user cockpit. It needs a focused rework before deeper Factory-alignment features depend on it.

## Guiding principles

1. **Factory alignment over workflow-DLS complexity**
   - Keep the product centered on missions, milestones, workers, validators, git handoffs, and Mission Control.
   - Do not add a large workflow language unless it directly improves mission reliability.

2. **Planning quality determines execution quality**
   - The planning phase should be rigorous, conversational, and visibly reviewable.
   - Execution should not begin from vague goals or weak validation criteria.

3. **Milestones are validation cadence**
   - Features are units of implementation.
   - Milestones are checkpoints where accumulated work is validated and stabilized.

4. **Sequential writes, parallel reads**
   - Preserve sequential write execution for correctness.
   - Allow safe parallelism for read-only research, review, and validation probes.

5. **Git and artifacts are the source of truth**
   - Every run should leave inspectable artifacts.
   - Recovery should be possible after crashes, context resets, or blocked child sessions.

6. **Mission Control is a project-manager cockpit**
   - It should not only display state; it should help the user redirect the orchestrator and recover the mission.

7. **Thin deterministic layer, strong invariants**
   - Keep decomposition and judgment in skills/models.
   - Keep state transitions, locks, schemas, artifact validation, and safety gates deterministic.

8. **Milestones are the canonical feature container**
   - Persist features only inside milestones.
   - Do not maintain duplicate top-level feature state for milestone missions.
   - Legacy feature-only missions should be migrated into milestone form.

9. **UI is a client, not the control plane**
   - Mission execution, status, and recovery must remain independent of interactive UI.
   - Mission Control and chat are clients of runner state, not owners of it.
   - Preserve a path to future headless/cloud mission execution.

## Phase 0: stabilize the foundation

Goal: make the existing extension safer to modify and easier to release without changing the core user model.

### 0.1 Modularize the runtime

`extensions/missions/runtime-extension.ts` is currently too large. Split it into focused modules. The first foundation pass has established the seam by extracting low-risk pure helpers for paths, settings, JSON IO, and event logs into `extensions/missions/core/`; future work should continue with artifacts, runner, UI, tools, and commands without changing public command/tool names or the mission artifact layout.

Suggested structure:

```text
extensions/missions/
  index.ts
  core/
    paths.ts
    json.ts
    events.ts
    settings.ts
    state.ts
  artifacts/
    schemas.ts
    handoff.ts
    validation-report.ts
    review-report.ts
  runner/
    commands.ts
    execution.ts
    locks.ts
    recovery.ts
    child-sessions.ts
  ui/
    mission-control.ts
    panes.ts
    input.ts
    widget.ts
  tools/
    register-tools.ts
  commands/
    missions.ts
    mission-control.ts
```

Acceptance criteria:

- No single runtime module should remain responsible for UI, runner, artifact parsing, command registration, and state recovery at once.
- Existing commands/tools continue to work.
- Current validation scripts still pass.

### 0.2 Add production build output

Move from raw TypeScript extension loading to built JavaScript for published packages. The contributor workflow is now `npm run typecheck`, `npm test`, `npm run validate`, `npm run build`, and the aggregate `npm run check` before handoff or release.

Acceptance criteria:

- Add `npm run build`.
- Add `npm run check` that runs typecheck, tests, validation scripts, and build.
- `pi.pi.extensions` points to built JS for publication.
- `npm pack` contains only needed runtime/docs files.

### 0.3 Introduce real tests

Keep the existing validation scripts, but add a normal test runner such as Vitest.

Initial test targets:

- Mission state transitions.
- Mission id/path sanitization.
- Artifact schema validation.
- Runner command routing.
- Pause/resume/cancel semantics.
- Recovery gate behavior.
- Mission Control input action dispatch using fake contexts.

Acceptance criteria:

- Tests run without a real pi session.
- Temporary mission roots are isolated per test.
- Source-string checks are gradually replaced with behavior tests where practical.

### 0.4 Harden paths and schemas

Acceptance criteria:

- Mission IDs cannot escape the mission root.
- Disk artifacts validate against canonical schemas.
- `mission_write_plan` rejects structurally invalid mission plans with actionable errors.
- Corrupted artifacts produce clear blocked-state metadata.

## Phase 1: align core execution with Factory Missions

Goal: make missions behave like Factory-style milestone-driven orchestration rather than only feature-by-feature execution.

### 1.1 Make milestones first-class

Factory Missions use milestones to define validation frequency. `pi-missions` should do the same.

Required behavior:

- Mission plans must include milestones for non-trivial work.
- Features belong to milestones.
- Mission Control displays milestones as primary groups with nested features.
- Milestone status is derived from feature and validation state.
- Milestone validation runs after the milestone's features complete.
- A failed milestone validation blocks or generates repair work before the next milestone begins.

Acceptance criteria:

- A mission can run multiple features in a milestone, then run milestone validation over accumulated work.
- The extension can explain why a milestone is pending, running, blocked, or complete.
- Feature-level validation remains available where useful, but milestone validation is the main cadence.

### 1.2 Add planning readiness checks

Before execution, the orchestrator should present a plan that is visibly ready.

Plan readiness checklist:

- Goal and non-goals are clear.
- Assumptions and constraints are listed.
- Milestones are defined with validation intent.
- Features are scoped and ordered.
- Dependencies are explicit.
- Required skills are identified.
- User-testing needs are identified.
- Validation contract is implementation-independent.
- Estimated worker/validator run count is shown.
- Risks and likely blockers are listed.

Acceptance criteria:

- `/missions` planning output includes the checklist.
- `mission_write_plan` stores readiness metadata or emits readiness warnings.
- Execution confirmation references the plan estimate and major risks.

### 1.3 Add mission cost/duration estimates

Use Factory's planning heuristic as a baseline:

```text
total runs ≈ #features + 2 * #milestones
```

Acceptance criteria:

- Mission summaries show estimated worker, validator, reviewer, and user-testing runs.
- Mission Control displays actual vs estimated runs.
- Blocked/replanned missions update the estimate when follow-up work is added.

### 1.4 Implement explicit repair-loop semantics

Validation failures should produce structured recovery options, not only a generic blocked state.

Required behavior:

- Validator defects are stored with severity, evidence, affected feature/milestone, and suggested fix.
- The orchestrator can convert defects into follow-up features.
- Follow-up features retain provenance back to the validation run.
- Mission Control shows repair work as generated from validation.

Acceptance criteria:

- A failed validation can result in a generated fix feature without losing prior artifact history.
- The mission can resume after repair planning without treating the whole mission as failed.
- Reports distinguish original scope from validation-generated follow-up work.

## Phase 2: rework Mission Control and status UX

Goal: make Mission Control and mission status reliable, useful, and aligned with the main-chat orchestration model before building more advanced Factory-style behavior on top of them.

Dogfooding showed that the best orchestrator-chat UX is not necessarily an embedded chat inside Mission Control. The main chat can serve as the orchestrator channel as long as the mission context is lightweight, current, and actionable. Mission Control should become an observability and control surface, while main chat remains the place for natural-language intervention.

Core UX invariants:

- Mission execution must continue in the background without monopolizing the main chat.
- The user can keep chatting while workers and validators run.
- Main chat can inspect mission status, diagnose blocks, revise plans, pause/resume, and otherwise intercept a running mission.
- Mission Control must never show stale or misleading state after recovery.
- Mission Control should be useful even when the user never opens a separate orchestrator chat UI.

### 2.1 Rebuild Mission Control around a clean view model

Mission Control should not directly reason over raw, partially duplicated mission state. Introduce a single derived view model that status output and Mission Control can share.

Required behavior:

- Derive mission, milestone, feature, active-run, block, and artifact display state from one canonical function/module.
- Reconcile or clearly flag duplicated top-level vs milestone feature state.
- Suppress stale block summaries once a mission has recovered, resumed, or completed past that block.
- Show current active run and latest relevant run distinctly.
- Represent complete, running, paused, blocked, and recovered states consistently across `/missions status`, `mission_status`, and Mission Control.

Acceptance criteria:

- A recovered mission does not keep presenting an old block as the current problem.
- A complete mission does not show obsolete recovery guidance.
- Status text and Mission Control agree on current milestone, current feature, active run, and block state.
- View-model behavior is covered by unit tests with synthetic mission artifacts.

### 2.2 Simplify Mission Control panes and interactions

Mission Control should prioritize clarity over density.

Required behavior:

- Keep a stable feature/milestone tree.
- Show one obvious current-state summary.
- Show recent activity with meaningful labels, not raw noise.
- Show child output only when it helps diagnose the selected run.
- Make controls discoverable and safe.

Acceptance criteria:

- A user can answer “what is running?”, “what completed?”, “what is blocked?”, and “what should I do next?” within a few seconds.
- Key hints are accurate for the current focus/pane.
- Pane scroll/focus behavior is predictable and tested.
- Compact/narrow layouts remain usable.

### 2.3 Main-chat intervention as the orchestrator-chat feature

Rather than making an embedded Mission Control chat the primary feature, make main-chat mission intervention first-class.

Required interactions:

- “status update” returns concise current mission state.
- “pause after current” routes to the runner safely.
- “resume” routes through the confirmation/runner path.
- “why is it blocked?” inspects recovery artifacts and explains the cause.
- “drop/defer/add/change this feature” revises the plan and records why.
- “turn this validator finding into repair work” creates or updates follow-up work.

Acceptance criteria:

- The lightweight mission context is sufficient for the main assistant to identify the active mission and inspect details on demand.
- Mission Control can point users back to main chat for natural-language intervention instead of embedding a second chat surface.
- Plan revisions from main-chat intervention are recorded in mission artifacts/event logs.

### 2.4 Improve blocked-state and recovery UX

Blocked missions should be actionable and should not require manual artifact archaeology.

Acceptance criteria:

- Mission Control shows the current block reason, failed run, relevant artifacts, dirty git status if any, and recommended next actions.
- `/missions status` includes concise recovery guidance only when the mission is actually blocked.
- Recovered historical blocks remain inspectable as history but are not presented as current blockers.
- `/mission-orchestrator` or main-chat recovery opens with enough context to recover without re-reading everything manually.

### 2.5 Improve child-output and activity inspection

Acceptance criteria:

- Child output clearly distinguishes transcript messages, stderr, final response, artifact parse errors, and validation findings.
- Activity log supports filtering or at least grouping by feature, milestone, child role, and severity.
- Long outputs remain bounded and responsive.
- Validator pass/fail summaries are visible without opening raw artifacts.

## Phase 2.5: migrate mission state to milestone-canonical schema

Goal: remove duplicate feature state and make milestone grouping the single source of truth for execution, validation, status, recovery, and UI.

Dogfooding exposed a serious defect: milestone feature state and top-level feature state can drift. This caused false `no_runnable_pending_work` blocks after successful validation retries. Since Factory-style validation cadence is milestone-based, `mission.milestones[].features` should be canonical and top-level `mission.features` should no longer be persisted for milestone missions.

Required behavior:

- New mission plans persist features only inside `milestones[].features`.
- Feature-only legacy missions load by wrapping top-level `features` into a synthetic milestone.
- Hybrid legacy missions load by merging useful top-level metadata into milestone features once, then saving milestone-canonical state.
- Runner, validators, recovery, status, Mission Control, and tools read feature state from milestones only.
- `plan/features.json` may remain as a derived compatibility artifact, but it is not mission runtime state.
- Skills and docs stop instructing orchestrators to emit top-level `features` for new milestone missions.

Acceptance criteria:

- No saved milestone mission contains top-level `features` as mutable runtime state.
- Retry/validation completion cannot update one feature copy while the runner gates on another.
- Existing feature-only and hybrid mission artifacts remain loadable through migration.
- Tests cover feature-only, hybrid, and milestone-canonical mission loading/saving.
- Status and Mission Control still show feature progress after migration.

## Phase 3: strengthen validation and user testing

Goal: make validation feel like a real QA/review layer, not just another model response.

### 3.1 Milestone validation reports

Acceptance criteria:

- Add a canonical milestone validation report schema.
- Reports evaluate accumulated milestone work, integration risks, regressions, and validation-contract assertions.
- Reports can recommend accept, repair, replan, or ask-user.

### 3.2 User-testing artifacts

Factory emphasizes application navigation and human-like QA. `pi-missions` should support that where pi tooling allows it.

Acceptance criteria:

- Planning captures launch command, URL/entrypoint, credentials strategy, and flows to test.
- User-testing reports store commands, screenshots/log paths where available, observed behavior, and reproduction steps.
- Mission Control displays user-testing status and artifacts separately from scrutiny validation.

### 3.3 Read-only parallel review/research

Acceptance criteria:

- Support safe parallel reviewer/research agents that do not mutate the repository.
- Scrutiny validator can incorporate reviewer findings as advisory evidence.
- Parallel fanout is documented as read-only/safe-by-default.

## Phase 4: configuration inheritance and skills

Goal: make child agents inherit the user's pi/project environment predictably and make skills a visible planning artifact.

### 4.1 Document and verify inheritance

Factory Missions inherit MCP integrations, custom skills, hooks, custom droids, and project instructions. `pi-missions` needs an explicit pi equivalent.

Acceptance criteria:

- README documents what workers inherit: cwd, tools, MCP servers, skills, project instructions, environment, model settings, and extension context.
- Add a mission preflight diagnostic showing relevant inherited configuration.
- Missing or risky configuration appears as a planning warning.

### 4.2 Skill planning and lifecycle

Acceptance criteria:

- Planning identifies mission-specific skills required for workers/validators.
- Mission-specific skills are visible in Mission Control.
- The orchestrator can propose durable project skills when useful.
- Validators check whether workers followed required skills.

## Phase 5: production release hardening

Goal: make the extension safe and supportable for normal pi users.

### 5.1 CLI/doctor tooling

Add a small deterministic CLI for support and automation.

Possible commands:

```bash
pi-missions list
pi-missions status <id>
pi-missions inspect <id>
pi-missions validate <id>
pi-missions doctor
pi-missions export <id>
pi-missions repair-lock <id>
pi-missions clear-completed
```

Acceptance criteria:

- Users can inspect and validate missions outside an active pi session.
- `doctor` detects corrupt state, stale locks, missing artifacts, and version mismatches.

### 5.2 Safety and audit posture

Acceptance criteria:

- Document command execution model and trust boundaries.
- Confirm all execution-starting and destructive actions require explicit confirmation.
- Maintain append-only event logs for mission lifecycle events.
- Add guidance for secret scanning/hooks where available.
- Add artifact redaction/export guidance.

### 5.3 Documentation polish

Required docs:

- Quickstart.
- Mission lifecycle/state machine.
- Mission Control guide.
- Planning guide.
- Recovery cookbook.
- Artifact layout and schemas.
- Configuration inheritance.
- Model configuration.
- Troubleshooting.
- Release notes/changelog.

Acceptance criteria:

- A new user can complete a small mission from docs alone.
- A blocked mission can be recovered using docs alone.

### 5.4 CI and release process

Acceptance criteria:

- CI runs typecheck, tests, validation scripts, build, and npm pack smoke test.
- Releases follow semver.
- Package declares compatible pi versions.
- Changelog is maintained.

## Phase 6: advanced Factory-style capabilities

These are optional after the core product is stable.

### 6.1 Recursive orchestration

Explore sub-orchestrators for very large missions.

Guardrail:

- One orchestration layer should remain the default.
- Additional layers require clear evidence that coordination overhead is worth it.

### 6.2 Mission templates

Examples:

- Brownfield migration.
- Test coverage campaign.
- Full-stack prototype.
- Refactor with behavior preservation.
- Research/report mission.

### 6.3 Long-running telemetry and summaries

Acceptance criteria:

- Mission Control can show duration, token/run counts where available, retries, blocks, and validation outcomes.
- A completed mission can generate a final executive summary from artifacts.

## Phase 7: headless and remote mission execution

Goal: support planning a mission on one machine, moving it to another machine, running it non-interactively, and observing it programmatically.

This is a later roadmap item, but current architecture should avoid blocking it. The runner must not depend on TUI overlays, interactive confirmations, or session-local UI state.

Target workflows:

```bash
# local machine
pi-missions export mission-abc > mission-abc.tar.zst
scp mission-abc.tar.zst cloud:/tmp/

# cloud machine
pi-missions import /tmp/mission-abc.tar.zst --cwd /srv/repo
pi-missions run mission-abc --non-interactive --yes
pi-missions status mission-abc --json
pi-missions watch mission-abc --jsonl
```

Required behavior:

- Export/import portable mission bundles.
- Rebind mission `cwd` on import when moving between machines.
- Start/resume missions through an explicit non-interactive authorization path rather than interactive `ctx.ui.confirm`.
- Provide machine-readable `list`, `status`, and `watch` outputs.
- Emit append-only structured events suitable for external telemetry.
- Support cloud-runner configuration for models, tools, environment, git identity, maximum runtime/cost, telemetry sinks, and safety policy.

Acceptance criteria:

- A mission can be planned locally, imported remotely, run headlessly, and inspected without a TUI.
- Interactive safety gates remain intact for normal chat/TUI use; headless mode requires explicit CLI/API authorization.
- Mission Control, main chat, CLI JSON, and telemetry exporters share derived status/view-model logic.
- Documentation covers remote execution setup, security boundaries, and artifact retrieval.

## Immediate next milestones

Recommended implementation order:

1. Finish the read-only multi-mission Mission Control rework.
2. Immediately migrate mission state to milestone-canonical schema and remove duplicate top-level feature runtime state.
3. Make main-chat mission intervention the first-class orchestrator-chat experience.
4. Clean up stale block/recovery display and blocked-state guidance everywhere, including footer/status UI.
5. Continue modularizing runtime areas needed for Mission Control: UI panes, input handling, status formatting, and run/activity view models.
6. Make milestone validation the primary execution cadence.
7. Add planning readiness checklist and run estimates.
8. Add explicit repair features generated from validation findings.
9. Document configuration inheritance, recovery, and lifecycle states.
10. Prepare npm package and CI release process.
11. Much later: add headless/remote mission execution with export/import, non-interactive run, JSON status/watch, and telemetry.

## Definition of production ready

`pi-missions` is production ready when:

- It installs cleanly from npm as a built pi extension.
- It has a stable public command/tool/artifact contract.
- It can run a multi-hour mission, recover from interruption, and leave coherent artifacts.
- Milestone validation and repair loops work without manual artifact surgery.
- Mission Control supports monitoring and orchestrator intervention.
- Tests cover the core state machine, runner commands, artifact schemas, and recovery behavior.
- Documentation is sufficient for quickstart, mission management, and blocked-state recovery.
- The extension clearly explains its safety model and trust boundaries.
