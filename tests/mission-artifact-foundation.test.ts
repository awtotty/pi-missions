import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactValidationErrorSummary, validateMissionArtifact } from "../extensions/missions/runtime-artifact-schemas.js";
import { missionDir, missionRoot, readJson, writeJson } from "../extensions/missions/runtime-core.js";

const originalMissionHome = process.env.PI_MISSIONS_HOME;

afterEach(() => {
	if (originalMissionHome === undefined) delete process.env.PI_MISSIONS_HOME;
	else process.env.PI_MISSIONS_HOME = originalMissionHome;
});

describe("artifact schema validators", () => {
	it("accepts current scrutiny validation report artifacts", () => {
		const result = validateMissionArtifact("scrutiny-validation-report", {
			status: "fail",
			summary: "Validation found a defect.",
			featureId: "F2",
			commandsRun: [{ command: "npm run typecheck", exitCode: 0 }],
			assertions: [{ assertionId: "A1", status: "pass", evidence: "Types compile." }],
			defects: [{ id: "D1", severity: "major", title: "Missing test", description: "Coverage is absent.", reproduction: "Run npm test." }],
			procedureFindings: [{ id: "P1", severity: "minor", title: "Weak handoff", description: "Handoff lacks detail.", evidence: "handoff.md" }],
			recommendation: "fix",
		});

		expect(result).toEqual(expect.objectContaining({ ok: true, issues: [] }));
	});

	it("accepts current user-testing and reviewer report artifacts", () => {
		expect(validateMissionArtifact("user-testing-report", {
			status: "inconclusive",
			summary: "No browser flow applies.",
			featureId: "F2",
			commandsRun: [{ command: "npm test", exitCode: 0, notes: "unit-only feature" }],
		}).ok).toBe(true);

		expect(validateMissionArtifact("reviewer-report", {
			reviewerId: "reviewer-1",
			status: "pass",
			summary: "No blocking findings.",
			featureId: "F2",
			commandsRun: [{ command: "git diff --check", exitCode: 0 }],
			findings: [{ id: "R1", severity: "minor", title: "Nit", description: "Non-blocking note." }],
		}).ok).toBe(true);
	});

	it("reports canonical artifact path summaries for nested validation issues", () => {
		const result = validateMissionArtifact("scrutiny-validation-report", {
			status: "pass",
			summary: "Malformed nested fields.",
			commandsRun: [{ command: "npm test", exitCode: "0" }],
			assertions: [{ assertionId: "A1", status: "unknown", evidence: "checked" }],
			defects: [],
			procedureFindings: [],
			recommendation: "accept",
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toEqual(expect.arrayContaining([
			{ path: "/commandsRun/0/exitCode", message: "must be a number" },
			{ path: "/assertions/0/status", message: "must be one of: pass, fail, inconclusive" },
		]));
		expect(artifactValidationErrorSummary("scrutiny-validation-report", result.issues)).toContain("/assertions/0/status must be one of");
	});
});

describe("mission-state path and shape assumptions", () => {
	it("uses an isolated PI_MISSIONS_HOME as the mission root", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-test-"));
		process.env.PI_MISSIONS_HOME = tempRoot;

		expect(missionRoot("/unused/cwd")).toBe(tempRoot);
		expect(missionDir("/unused/cwd", "mission-alpha")).toBe(path.join(tempRoot, "mission-alpha"));
	});

	it("round-trips the current mission.json runtime shape in an isolated directory", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-test-"));
		process.env.PI_MISSIONS_HOME = tempRoot;
		const dir = missionDir("/repo", "mission-shape");
		const file = path.join(dir, "mission.json");
		const mission = {
			schemaVersion: 1,
			id: "mission-shape",
			title: "Shape test",
			status: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
			models: { orchestrator: "default", worker: "default", validator: "default" },
			currentFeatureId: "F1",
			features: [{ id: "F1", title: "Feature", description: "Do work", dependencies: [], status: "running", runId: "run-1" }],
			milestones: [{ id: "M1", title: "Milestone", objective: "Validate cadence", validation: "Run checks", status: "running", features: [] }],
			activeRun: { schemaVersion: 1, kind: "worker", itemId: "F1", runId: "run-1", parentPid: 123, parentSessionMarker: "pid-123", startedAt: "2026-01-01T00:00:00.000Z", intent: "active" },
		};

		writeJson(file, mission);

		expect(fs.existsSync(file)).toBe(true);
		expect(readJson<typeof mission>(file)).toEqual(mission);
	});
});
