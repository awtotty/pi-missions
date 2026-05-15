import { describe, expect, it } from "vitest";
import { artifactValidationErrorSummary, validateMissionArtifact } from "../extensions/missions/runtime-artifact-schemas.js";

describe("validateMissionArtifact", () => {
  it("accepts a complete worker handoff artifact", () => {
    const result = validateMissionArtifact("worker-handoff", {
      featureId: "F1",
      status: "complete",
      commit: "abc1234",
      summary: "Implemented the feature.",
      implemented: ["Added build infrastructure"],
      leftUndone: [],
      filesChanged: ["package.json"],
      commandsRun: [{ command: "npm test", exitCode: 0 }],
      issuesDiscovered: [],
      procedureCompliance: {
        readMissionContext: true,
        checkedGitStatusBeforeWork: true,
        ranRequiredValidation: true,
        committedChanges: true,
        updatedHandoff: true,
      },
      risks: [],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports actionable paths for malformed artifacts", () => {
    const result = validateMissionArtifact("worker-handoff", {
      featureId: "F1",
      status: "done",
      summary: "Missing required fields.",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "/status", message: "must be one of: complete, blocked, failed" },
        { path: "/commit", message: "is required" },
        { path: "/procedureCompliance", message: "is required and must be an object" },
      ]),
    );
    expect(artifactValidationErrorSummary("worker-handoff", result.issues)).toContain("/status must be one of");
  });

  it("accepts the runtime orchestrator recovery packet contract", () => {
    const result = validateMissionArtifact("runtime-orchestrator-recovery-packet", recoveryPacket());

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects recovery packets that route to main chat or allow repository edits", () => {
    const packet = recoveryPacket();
    packet.dispatch.target = "main-chat";
    packet.authority.runtimeOrchestrator.mayEditRepositoryImplementation = true;
    packet.authority.runtimeOrchestrator.repositoryEditPolicy = "allowed";
    packet.allowedOutcomes = packet.allowedOutcomes.filter((option) => option.outcome !== "ask-user");

    const result = validateMissionArtifact("runtime-orchestrator-recovery-packet", packet);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      { path: "/dispatch/target", message: "must be dedicated-runtime-orchestrator-session" },
      { path: "/authority/runtimeOrchestrator/mayEditRepositoryImplementation", message: "must be false" },
      { path: "/authority/runtimeOrchestrator/repositoryEditPolicy", message: "must be forbidden-by-default" },
      { path: "/allowedOutcomes", message: "must include outcome: ask-user" },
    ]));
    expect(artifactValidationErrorSummary("runtime-orchestrator-recovery-packet", result.issues)).toContain("Runtime orchestrator recovery packet schema error");
  });
});

function recoveryPacket(): any {
  return {
    schemaVersion: 1,
    missionId: "mission-alpha",
    missionTitle: "Mission Alpha",
    status: "orchestrator_action_required",
    createdAt: "2026-01-01T00:00:00.000Z",
    block: {
      schemaVersion: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      reasonCategory: "validator_report_failed",
      kind: "validator",
      validatorMode: "scrutiny",
      failedItemId: "M1",
      failedItemTitle: "Milestone 1",
      missionId: "mission-alpha",
      milestoneId: "M1",
      runId: "run-validator-M1",
      runDir: "/tmp/run-validator-M1",
      exitCode: 0,
      status: "fail",
      artifactPaths: ["/tmp/run-validator-M1/validation-report.json"],
    },
    dispatch: {
      target: "dedicated-runtime-orchestrator-session",
      trigger: "runner-after-block",
      runnerWritesPacket: true,
      fallback: "main-chat-display-only",
      orchestratorSessionRecordPath: "/tmp/mission-alpha/orchestrator-session.json",
    },
    authority: {
      runner: ["Writes packet and stops."],
      runtimeOrchestrator: {
        mayUseMissionTools: true,
        mayReviseMissionMetadata: true,
        mayEditRepositoryImplementation: false,
        repositoryEditPolicy: "forbidden-by-default",
      },
      mainChat: ["Human override."],
      missionControl: "read-only-observability",
    },
    allowedOutcomes: [
      { outcome: "resume", description: "Resume the runner.", safeWhen: "State is runnable." },
      { outcome: "ask-user", description: "Ask the user.", safeWhen: "Human input is needed.", requiresHuman: true },
      { outcome: "leave-blocked", description: "Leave blocked.", safeWhen: "No safe action exists." },
      { outcome: "retry-repair", description: "Repair metadata or retry.", safeWhen: "Mission metadata revision can unblock." },
      { outcome: "rerun-validation", description: "Rerun validation.", safeWhen: "Validation can be safely rerun." },
    ],
    instructions: ["Do not edit repository implementation code by default."],
  };
}
