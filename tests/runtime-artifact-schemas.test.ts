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
});
