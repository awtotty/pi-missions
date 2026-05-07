# Missions

Missions is a system that combines delegation, creator-verifier, broadcast, and negotiation paradigms for multi-agent systems into a single workflow.

## The Flow

1. Describes a software goal
2. Scope the goals through conversation
3. Approve the plan
4. Missions handles execution

## Roles

Three-role architecture:

- The Orchestrator: plans features, milestones, and validation contract
- Workers (child): fresh context per feature; implement, commit via git, handoff
- Validator (child): adversarial verification; have never seen the code before

## Validation Loop

### Planning Phase

The **validation contract** defines what "done" means before any code is written. Written by the orchstrator during planning, before any code. Hundreds of assertions define correctness independently of implementation.

### After Each Milestone

- Scrutiny validator: runs tests, type checks, lints; spawns code review agents for each completed feature
- User-testing validator: acts like a QA engineer; launches the app, navigates via computer-use, and verifies flows end-to-end

## Structured Handoffs

How agents stay coherent over days, not just minutes

Every worker reports:

- What was implemented
- What was left undone
- Command runs and exit codes
- Issues discovered
- Whether procedures were followed

## Sequential Execution

Features execute one at a time. Each worker inherits the full codebase from the last through git.
Parallelism is reserved for work that can't conflict: codebase exploration, API research, documentation reads, and validation reviews.

This is slower on paper than parallelism, but for multi-day runs, correctness compounds.

## Mission Control

A dedicated view for multi-day autonomous work. Monitor, redirect, or come back tomorrow.

## Model Config Per Role

Pick the right model per role:

- Planning: slow, careful reasoning; strategic questions, constraint analysis
- Implementation: code fluency and creativity; fast generation, tool use
- Validation: strict instruction following; different provider avoids training-data bias

## Designed to Not Be Made Obsolete

Almost all orchestration logic lives in prompts and skills:

- How it decomposes features
- How it handles failures
- When it escalates

Worker behavior is driven by skills the orchestrator defines per-mission.
When a better model drops, the system just gets better, no code changes needed.

### The Thin Deterministic Layer

Hardcoded to handle bookkeeping:

- Triggering validation
- Blocking progress when handoff issues aren't addressed

Missions ensure discipline. The models provide intelligence.

## References

- https://www.youtube.com/watch?v=ow1we5PzK-o&t=198s
- https://docs.factory.ai/cli/features/missions#configuration-inheritance
