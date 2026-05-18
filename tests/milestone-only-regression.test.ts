import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing as runtimeTesting } from "../extensions/missions/runtime-extension.js";
import { ensureDir, readJson, writeJson } from "../extensions/missions/runtime-core.js";

const runtimeSource = fs.readFileSync(path.join(process.cwd(), "extensions/missions/runtime-extension.ts"), "utf8");

function functionBody(name: string): string {
	const start = runtimeSource.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
	const openBrace = runtimeSource.indexOf("{\n", start);
	expect(openBrace, `missing function body for ${name}`).toBeGreaterThanOrEqual(0);
	let depth = 0;
	let started = false;
	for (let index = openBrace; index < runtimeSource.length; index += 1) {
		const char = runtimeSource[index];
		if (char === "{") {
			depth += 1;
			started = true;
		} else if (char === "}") {
			depth -= 1;
			if (started && depth === 0) return runtimeSource.slice(start, index + 1);
		}
	}
	throw new Error(`unterminated function ${name}`);
}

describe("milestone-only mission runtime regressions", () => {
	it("normalizes raw validation assertion arrays to the persisted contract shape", () => {
		const raw = [{ id: "A-1", category: "integration", assertion: "validators can see this", verification: "inspect contract" }];
		expect(runtimeTesting.normalizeValidationContractJson(raw)).toEqual({ assertions: raw });
		expect(runtimeTesting.normalizeValidationContractJson({ assertions: raw })).toEqual({ assertions: raw });
		expect(runtimeTesting.normalizeValidationContractJson({ notAssertions: raw })).toEqual({ assertions: [] });
	});

	it("persists milestone mission state without top-level features", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-milestone-only-"));
		const file = path.join(tempRoot, "mission.json");
		const mission = {
			schemaVersion: 1,
			id: "mission-milestone-only",
			title: "Milestone-only test",
			status: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
			models: { orchestrator: "default", worker: "default", validator: "default" },
			currentMilestoneId: "M1",
			currentFeatureId: "F1",
			milestones: [{
				id: "M1",
				title: "Milestone",
				objective: "Validate milestone-canonical state",
				validation: "Run regression checks",
				status: "running",
				features: [{ id: "F1", title: "Feature", description: "Do work", dependencies: [], status: "running", runId: "run-1" }],
			}],
			activeRun: { schemaVersion: 1, kind: "worker", itemId: "F1", runId: "run-1", parentPid: 123, parentSessionMarker: "pid-123", startedAt: "2026-01-01T00:00:00.000Z", intent: "active" },
		};

		writeJson(file, mission);
		const saved = readJson<typeof mission & { features?: unknown[] }>(file);

		expect(saved.features).toBeUndefined();
		expect(saved.milestones[0].features).toHaveLength(1);
		expect(saved.milestones[0].features[0]).toMatchObject({ id: "F1", status: "running", runId: "run-1" });
	});

	it("derives progress and next-feature gates from milestone features", () => {
		expect(functionBody("missionFeatureList")).toContain("return missionMilestones(mission).flatMap((milestone) => milestone.features);");
		expect(functionBody("featureStatusById")).toContain("for (const milestone of missionMilestones(mission))");
		const nextFeature = functionBody("findNextFeature");
		expect(nextFeature).toContain("const statuses = featureStatusById(mission);");
		expect(nextFeature).toContain("for (const feature of missionFeatureList(mission))");
		expect(nextFeature).toContain("const milestone = milestoneForFeature(mission, feature.id);");
		expect(nextFeature).not.toContain("mission.features");
	});

	it("saves transition metadata from milestone features and drops stale duplicate top-level features", () => {
		const originalHome = process.env.PI_MISSIONS_HOME;
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-stale-top-level-"));
		process.env.PI_MISSIONS_HOME = tempHome;
		try {
			const cwd = path.join(tempHome, "repo");
			const missionDir = path.join(tempHome, "mission-stale-duplicate");
			ensureDir(missionDir);
			const mission = {
				schemaVersion: 1 as const,
				id: "mission-stale-duplicate",
				title: "Stale duplicate regression",
				status: "running" as const,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				cwd,
				models: { orchestrator: "default", worker: "default", validator: "default" },
				currentMilestoneId: "M1",
				currentFeatureId: "F1",
				features: [{ id: "F1", title: "Feature", description: "stale copy", dependencies: [], status: "running" as const, runId: "stale-worker-run" }],
				milestones: [{
					id: "M1",
					title: "Milestone",
					objective: "Validate persistence after retry/validation transitions",
					validation: "Save after transition metadata is recorded",
					status: "running" as const,
					validationRunId: "validator-run-1",
					validationState: { runId: "validator-run-1", failureCount: 2 },
					features: [{
						id: "F1",
						title: "Feature",
						description: "canonical milestone copy",
						dependencies: [],
						status: "complete" as const,
						runId: "canonical-worker-run",
						validationRunId: "legacy-feature-validator-run",
						userTestingRunId: "legacy-user-testing-run",
						reviewerRunIds: ["legacy-reviewer-run"],
						commit: "abc1234",
					}],
				}],
			};

			runtimeTesting.saveMission(cwd, mission);

			const saved = readJson<typeof mission>(path.join(missionDir, "mission.json"));
			expect(saved.features).toBeUndefined();
			expect(saved.milestones[0].status).toBe("complete");
			expect(saved.milestones[0]).toMatchObject({ validationRunId: "validator-run-1", validationState: { runId: "validator-run-1", failureCount: 2 } });
			expect(saved.milestones[0].features[0]).toMatchObject({
				id: "F1",
				status: "complete",
				runId: "canonical-worker-run",
				commit: "abc1234",
			});
			expect(saved.milestones[0].features[0].validationRunId).toBeUndefined();
			expect(saved.milestones[0].features[0].userTestingRunId).toBeUndefined();
			expect(saved.milestones[0].features[0].reviewerRunIds).toBeUndefined();
			const loaded = runtimeTesting.loadMission(cwd, "mission-stale-duplicate");
			expect(loaded.features).toBeUndefined();
			expect(loaded.milestones?.[0]?.validationRunId).toBe("validator-run-1");
		} finally {
			if (originalHome === undefined) delete process.env.PI_MISSIONS_HOME;
			else process.env.PI_MISSIONS_HOME = originalHome;
		}
	});

	it("validation, retry, and persistence paths cannot reintroduce duplicate feature state", () => {
		const persistence = functionBody("missionForPersistence");
		expect(persistence).toContain("delete persisted.features");
		expect(functionBody("stripLegacyFeatureValidationState")).toContain("delete persisted.validationRunId");
		expect(functionBody("saveMission")).toContain("writeJson(path.join(missionDir(cwd, mission.id), \"mission.json\"), missionForPersistence(mission));");

		const retry = runtimeSource.slice(runtimeSource.indexOf('if (input.command === "retry-feature")'), runtimeSource.indexOf('if (input.command === "block")'));
		expect(retry).toContain("const feature = missionFeatureList(mission).find((item) => item.id === featureId);");
		expect(retry).not.toContain("mission.features");

		for (const name of ["findFeatureAwaitingValidation", "findFeatureAwaitingUserTesting", "incompleteFeatures"]) {
			const body = functionBody(name);
			expect(body).toContain("missionFeatureList(mission)");
			expect(body).not.toContain("mission.features");
		}
	});

	it("models scrutiny and user-testing as explicit validator modes", () => {
		const runValidator = functionBody("runValidator");
		expect(runValidator).toContain('setActiveRunOwnership(mission, { kind: "validator", validatorMode: "scrutiny"');
		expect(runValidator).toContain('validatorMode: "scrutiny"');
		expect(runValidator).toContain('nextChildAttemptNumber(mission.cwd, mission.id, "validator", targetFeature?.id, "scrutiny")');
		expect(runValidator).toContain('kind: "validator",\n\t\t\tvalidatorMode: "scrutiny"');

		const runUserTestingValidator = functionBody("runUserTestingValidator");
		expect(runUserTestingValidator).toContain('setActiveRunOwnership(mission, { kind: "validator", validatorMode: "user-testing"');
		expect(runUserTestingValidator).toContain('validatorMode: "user-testing"');

		const contexts = functionBody("missionRunContexts");
		expect(contexts).toContain('validatorMode: "scrutiny"');
		expect(contexts).toContain('validatorMode: "user-testing"');
	});

	it("runs milestone workers before boundary validators and advances after passing validation", () => {
		const mission = {
			schemaVersion: 1 as const,
			id: "mission-run-loop-order",
			title: "Run loop order",
			status: "running" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
			models: { orchestrator: "default", worker: "default", validator: "default" },
			currentMilestoneId: "M1",
			milestones: [{
				id: "M1",
				title: "Milestone 1",
				status: "running" as const,
				features: [
					{ id: "F1", title: "First", description: "Do first", dependencies: [], status: "complete" as const },
					{ id: "F2", title: "Second", description: "Do second", dependencies: ["F1"], status: "pending" as const },
				],
			}, {
				id: "M2",
				title: "Milestone 2",
				status: "pending" as const,
				features: [
					{ id: "F3", title: "Third", description: "Do next milestone", dependencies: ["F2"], status: "pending" as const },
				],
			}],
		};

		const milestone = runtimeTesting.currentRunnableMilestone(mission)!;
		expect(milestone.id).toBe("M1");
		expect(runtimeTesting.findNextFeatureInMilestone(mission, milestone)?.id).toBe("F2");
		expect(runtimeTesting.milestoneAwaitingScrutinyValidation(milestone)).toBe(false);

		milestone.features[1].status = "complete";
		expect(runtimeTesting.findNextFeatureInMilestone(mission, milestone)).toBeUndefined();
		expect(runtimeTesting.milestoneAwaitingScrutinyValidation(milestone)).toBe(true);

		milestone.validationState = { runId: "validator-M1" };
		milestone.validationRunId = "validator-M1";
		milestone.status = "complete";
		expect(runtimeTesting.milestoneAwaitingScrutinyValidation(milestone)).toBe(false);
		const nextMilestone = runtimeTesting.currentRunnableMilestone(mission)!;
		expect(nextMilestone.id).toBe("M2");
		expect(runtimeTesting.findNextFeatureInMilestone(mission, nextMilestone)?.id).toBe("F3");
		expect(mission.status).toBe("running");
		expect(milestone.status).toBe("complete");
	});

	it("uses distinct milestone user-testing validator mode when configured", () => {
		const milestone = {
			id: "M1",
			title: "Milestone",
			status: "running" as const,
			validationRunId: "scrutiny-M1",
			validationState: { runId: "scrutiny-M1", userTesting: { required: true, instructions: "exercise the integrated milestone" } },
			features: [{ id: "F1", title: "Feature", description: "Done", dependencies: [], status: "complete" as const }],
		};

		expect(runtimeTesting.milestoneAwaitingUserTestingValidation(milestone)).toBe(true);
		milestone.validationState.userTestingRunId = "user-testing-M1";
		expect(runtimeTesting.milestoneAwaitingUserTestingValidation(milestone)).toBe(false);

		const runMilestoneUserTestingValidator = functionBody("runMilestoneUserTestingValidator");
		expect(runMilestoneUserTestingValidator).toContain('setActiveRunOwnership(mission, { kind: "validator", validatorMode: "user-testing", itemId: milestone.id');
		expect(runMilestoneUserTestingValidator).toContain('systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-user-testing/SKILL.md")]');
		expect(runMilestoneUserTestingValidator).toContain("Execute user-testing validation for this completed milestone");
	});

	it("blocks validation failures for orchestrator intervention and enforces per-milestone limits independently", () => {
		const mission = {
			schemaVersion: 1 as const,
			id: "mission-validation-limits",
			title: "Validation limits",
			status: "running" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
			models: { orchestrator: "default", worker: "default", validator: "default" },
			validation: { failureLimit: 4 },
			milestones: [
				{ id: "M1", title: "Default", status: "pending" as const, features: [], validationState: { failureCount: 1 } },
				{ id: "M2", title: "Override", status: "pending" as const, features: [], validationState: { failureLimit: 2 } },
			],
		};

		expect(runtimeTesting.effectiveMilestoneValidationFailureLimit({ ...mission, validation: undefined }, mission.milestones[0])).toBe(5);
		expect(runtimeTesting.effectiveMilestoneValidationFailureLimit(mission, mission.milestones[0])).toBe(4);
		expect(runtimeTesting.effectiveMilestoneValidationFailureLimit(mission, mission.milestones[1])).toBe(2);
		expect(runtimeTesting.milestoneValidationFailureCount(mission.milestones[0])).toBe(1);
		const firstFailure = runtimeTesting.transitionMilestoneValidationFailureToBlocked(mission, mission.milestones[0]);
		expect(firstFailure).toMatchObject({ failureCount: 2, failureLimit: 4, limitExceeded: false });
		expect(firstFailure.status).toContain("orchestrator intervention required");
		expect(firstFailure.status).not.toContain("limit exceeded");
		expect(mission.status).toBe("blocked");
		expect(mission.milestones[0].status).toBe("failed");
		expect(mission.milestones[1].validationState?.failureCount).toBeUndefined();

		mission.status = "running";
		mission.milestones[1].status = "running";
		const belowLimit = runtimeTesting.transitionMilestoneValidationFailureToBlocked(mission, mission.milestones[1]);
		expect(belowLimit).toMatchObject({ failureCount: 1, failureLimit: 2, limitExceeded: false });
		expect(mission.milestones[0].validationState?.failureCount).toBe(2);
		mission.status = "running";
		mission.milestones[1].status = "running";
		const limitExceeded = runtimeTesting.transitionMilestoneValidationFailureToBlocked(mission, mission.milestones[1]);
		expect(limitExceeded).toMatchObject({ failureCount: 2, failureLimit: 2, limitExceeded: true });
		expect(limitExceeded.status).toContain("validation failure limit exceeded");

		const defaultLimitMission = {
			...mission,
			status: "running" as const,
			validation: undefined,
			milestones: [
				{ id: "M3", title: "Default limit", status: "running" as const, features: [], validationState: { failureCount: 4 } },
			],
		};
		const defaultLimitExceeded = runtimeTesting.transitionMilestoneValidationFailureToBlocked(defaultLimitMission, defaultLimitMission.milestones[0]);
		expect(defaultLimitExceeded).toMatchObject({ failureCount: 5, failureLimit: 5, limitExceeded: true });
		expect(defaultLimitExceeded.status).toContain("validation failure limit exceeded");
		expect(defaultLimitMission.status).toBe("blocked");
		expect(defaultLimitMission.milestones[0].status).toBe("failed");
	});
});
