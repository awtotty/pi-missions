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

## Phase 0: stabilize the foundation

Goal: make the existing extension safer to modify and easier to release without changing the core user model.

### 0.1 Modularize the runtime

`extensions/missions/runtime-extension.ts` is currently too large. Split it into focused modules.

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

Move from raw TypeScript extension loading to built JavaScript for published packages.

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

## Phase 2: make Mission Control a project-manager cockpit

Goal: allow the user to manage the mission the way Factory describes: monitoring, unblocking, redirecting, and replanning through the orchestrator.

### 2.1 Integrate orchestrator chat

Mission Control should provide an obvious way to talk to the orchestrator.

Required interactions:

- Open/switch to orchestrator chat from Mission Control.
- Ask the orchestrator to replan.
- Add a constraint.
- Prioritize/deprioritize a feature.
- Drop or defer scope.
- Convert a validator finding into follow-up work.
- Pause after current and request a plan revision.

Acceptance criteria:

- A user can redirect a running or blocked mission without manually locating mission IDs or artifact paths.
- Mission Control records intervention events in the mission event log.

### 2.2 Improve blocked-state UX

Blocked missions should be actionable.

Acceptance criteria:

- Mission Control shows the block reason, failed run, relevant artifacts, dirty git status if any, and recommended next actions.
- `/missions status` includes concise recovery guidance.
- `/mission-orchestrator` opens with enough context to recover without re-reading everything manually.

### 2.3 Improve child-output and activity inspection

Acceptance criteria:

- Child output clearly distinguishes stdout-like transcript, stderr, final response, artifact parse errors, and validation findings.
- Activity log supports filtering by feature, milestone, child role, and severity.
- Long outputs remain bounded and responsive.

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

## Immediate next milestones

Recommended implementation order:

1. Modularize runtime and add build/check scripts.
2. Add canonical schemas and Vitest tests for state/artifacts/runner commands.
3. Make milestone validation the primary execution cadence.
4. Add planning readiness checklist and run estimates.
5. Add explicit repair features generated from validation findings.
6. Add Mission Control orchestrator-intervention workflow.
7. Document configuration inheritance, recovery, and lifecycle states.
8. Prepare npm package and CI release process.

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
