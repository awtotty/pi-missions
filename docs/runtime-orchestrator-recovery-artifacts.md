# Runtime orchestrator recovery artifact contract

When deterministic mission execution encounters a recoverable block, the runner records block metadata and writes a runtime orchestrator recovery packet under the mission directory. The packet is a handoff contract between the deterministic runner and the mission's dedicated runtime orchestrator session.

## Packet shape

Recovery packet JSON artifacts use `schemaVersion: 1`, `status: "orchestrator_action_required"`, and include:

- `block`: the `MissionBlockMetadata` that identifies the failed worker/validator unit, run directory, reason category, exit code, and related artifacts.
- `dispatch`: declares `target: "dedicated-runtime-orchestrator-session"`, `trigger: "runner-after-block"`, `runnerWritesPacket: true`, and `fallback: "main-chat-display-only"`.
- `authority`: states that the runner owns deterministic sequencing, the runtime orchestrator may use mission tools/APIs to revise mission metadata/control state, main chat is the human command/override channel, and Mission Control is read-only observability.
- `allowedOutcomes`: exactly the recovery choices the runtime orchestrator may drive.
- `instructions`: concrete recovery instructions for the orchestrator turn.

## Allowed recovery outcomes

- `resume`: resume the deterministic runner when mission metadata is consistent and pending work is runnable.
- `ask-user`: ask the user in main chat when safe recovery depends on product, policy, or external input.
- `leave-blocked`: keep the mission blocked with a clear reason when no safe repair is available.
- `retry-repair`: use mission metadata/control-state revision or runner commands to repair stale/procedural/planning state or retry where safe.
- `rerun-validation`: rerun validation only when artifacts were missing, stale, inconclusive for environment/procedure reasons, or otherwise safe to repeat.

## Repository edit boundary

Runtime orchestrator recovery is not an implementation session. The contract requires `authority.runtimeOrchestrator.mayEditRepositoryImplementation: false` and `repositoryEditPolicy: "forbidden-by-default"`.

If recovery requires code changes, the orchestrator should revise mission metadata/plan so a worker feature performs the implementation repair under the normal worker contract.
