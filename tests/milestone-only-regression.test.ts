import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../extensions/missions/runtime-core.js";

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

	it("validation, retry, and persistence paths cannot reintroduce duplicate feature state", () => {
		const persistence = functionBody("missionForPersistence");
		expect(persistence).toContain("delete persisted.features");
		expect(functionBody("saveMission")).toContain("writeJson(path.join(missionDir(cwd, mission.id), \"mission.json\"), missionForPersistence(mission));");

		const retry = runtimeSource.slice(runtimeSource.indexOf('if (input.command === "retry-feature")'), runtimeSource.indexOf('if (input.command === "block")'));
		expect(retry).toContain("const feature = missionFeatureList(mission).find((item) => item.id === featureId);");
		expect(retry).not.toContain("mission.features");

		for (const name of ["findFeatureAwaitingValidation", "findFeatureAwaitingReviewers", "findFeatureAwaitingUserTesting", "incompleteFeatures"]) {
			const body = functionBody(name);
			expect(body).toContain("missionFeatureList(mission)");
			expect(body).not.toContain("mission.features");
		}
	});
});
