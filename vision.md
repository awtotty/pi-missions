# pi-missions vision

pi-missions brings long-running, milestone-based coding missions to pi.

The design is inspired by public descriptions of [Factory Missions for Droid](https://factory.ai/news/missions), but pi-missions is independent: it is not affiliated with Factory and was built without access to Factory Missions source code.

## Flow

1. The user describes a software goal.
2. The `mission-plan` skill helps refine scope, assumptions, milestones, features, and validation criteria.
3. The user reviews and explicitly approves execution.
4. The deterministic runner executes workers sequentially and validates at milestone boundaries.
5. Mission Control and status commands provide read-only observability.
6. Recoverable blocks route to the runtime `mission-orchestrator` session.

## Roles

- **Planner:** current-chat planning before execution starts.
- **Worker:** fresh context per feature; implements, commits via git, and writes a handoff.
- **Validator:** adversarial milestone verification through scrutiny or optional user-testing mode.
- **Runtime orchestrator:** event-driven recovery coordinator after execution starts.

## Principles

- Sequential writes; parallelism only for safe read-only work.
- Git commits and structured artifacts are the source of truth.
- Validation criteria are written before implementation.
- Mission Control is read-only observability, not the control plane.
- Recovery should preserve good work and make the next runner action explicit.
- Most orchestration intelligence lives in prompts, skills, and artifacts; deterministic code enforces state, locks, gates, and safety boundaries.
