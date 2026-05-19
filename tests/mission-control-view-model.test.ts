import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMissionControlViewModel, loadMissionControlViewModel } from "../extensions/missions/core/mission-control-view-model.js";
import type { MissionBlockMetadata, MissionState } from "../extensions/missions/runtime-types.js";

const tmpRoots: string[] = [];

afterEach(() => {
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function mission(id: string, status: MissionState["status"], extra: Partial<MissionState> = {}): MissionState {
	return {
		schemaVersion: 1,
		id,
		title: `Mission ${id}`,
		status,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: `2026-01-01T00:0${id.length}:00.000Z`,
		cwd: `/workspace/${id}`,
		models: { orchestrator: "default", worker: "default", validator: "default" },
		milestones: [{
			id: "M1",
			title: "Milestone",
			status: status === "complete" ? "complete" : status === "running" ? "running" : "pending",
			features: [
				{ id: "F1", title: "First", description: "", status: "complete" },
				{ id: "F2", title: "Second", description: "", status: "pending" },
			],
		}],
		...extra,
	};
}

const block: MissionBlockMetadata = {
	schemaVersion: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	reasonCategory: "missing_handoff",
	kind: "worker",
	failedItemId: "F2",
	failedItemTitle: "Second",
	missionId: "blocked",
	milestoneId: "M1",
	featureId: "F2",
	runId: "run-blocked",
	runDir: "/tmp/run-blocked",
	exitCode: 1,
	artifactPaths: [],
};

describe("mission control view model", () => {
	it("groups visible missions in read-only section order", () => {
		const vm = createMissionControlViewModel([
			mission("done", "complete"),
			mission("pause", "paused"),
			mission("plan", "planned"),
			mission("run", "running"),
			mission("bad", "failed"),
			mission("block", "blocked"),
		]);

		expect(vm.sections.map((section) => section.id)).toEqual(["blockedFailed", "running", "paused", "planned", "completed"]);
		expect(vm.sections.map((section) => section.missions.map((m) => m.status))).toEqual([
			["blocked", "failed"],
			["running"],
			["paused"],
			["planned"],
			["complete"],
		]);
	});

	it("computes feature progress and exposes a mission outline from milestone features", () => {
		const vm = createMissionControlViewModel([
			mission("progress", "running", {
				currentMilestoneId: "M1",
				currentFeatureId: "F3",
				milestones: [{
					id: "M1",
					title: "Milestone",
					status: "running",
					features: [
						{ id: "F1", title: "Done", description: "", status: "complete" },
						{ id: "F2", title: "Skipped", description: "", status: "skipped" },
						{ id: "F3", title: "Todo", description: "", status: "pending" },
					],
				}],
			}),
		]);

		expect(vm.missions[0].progress).toEqual({ completed: 2, total: 3 });
		expect(vm.missions[0].outline).toEqual([{
			id: "M1",
			title: "Milestone",
			status: "running",
			current: true,
			features: [
				{ id: "F1", title: "Done", status: "complete", current: false },
				{ id: "F2", title: "Skipped", status: "skipped", current: false },
				{ id: "F3", title: "Todo", status: "pending", current: true },
			],
		}]);
	});

	it("derives concise current task and cwd/repo/worktree labels", () => {
		const vm = createMissionControlViewModel([
			mission("labels", "running", {
				cwd: "/workspace/project/worktrees/feature-a",
				currentFeatureId: "F2",
			}),
		]);

		expect(vm.missions[0]).toMatchObject({
			currentTask: "F2: Second",
			cwdLabel: "/workspace/project/worktrees/feature-a",
			repoLabel: "feature-a",
			worktreeLabel: "worktrees/feature-a",
			locationLabel: "worktrees/feature-a",
		});
	});

	it("suppresses stale block data after a mission recovers", () => {
		const vm = createMissionControlViewModel([
			mission("recovered", "running", { latestBlock: block }),
			mission("blocked", "blocked", { latestBlock: block }),
		]);

		expect(vm.missions.find((item) => item.id === "recovered")?.currentBlock).toBeUndefined();
		expect(vm.missions.find((item) => item.id === "blocked")?.currentBlock?.runId).toBe("run-blocked");
	});

	it("loads all non-cleared mission artifacts from a mission root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-vm-"));
		tmpRoots.push(root);
		for (const state of [mission("visible", "running"), mission("hidden", "complete")]) {
			const dir = path.join(root, state.id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify(state));
		}
		fs.writeFileSync(path.join(root, "cleared.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "now", clearedMissionIds: ["hidden"] }));

		const vm = loadMissionControlViewModel(process.cwd(), { root });

		expect(vm.missions.map((item) => item.id)).toEqual(["visible"]);
	});

	it("selects running active transcript output and labels stderr separately", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-vm-"));
		tmpRoots.push(root);
		const state = mission("run-output", "running", {
			activeRun: { schemaVersion: 1, kind: "worker", itemId: "F2", runId: "run-active", parentPid: 1, parentSessionMarker: "pid-1", startedAt: "now", intent: "active" },
		});
		const runDir = path.join(root, state.id, "runs", "run-active");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(root, state.id, "mission.json"), JSON.stringify(state));
		fs.writeFileSync(path.join(runDir, "transcript.jsonl"), `${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "working on it" }, { type: "tool_use", name: "bash" }] })}\n`);
		fs.writeFileSync(path.join(runDir, "stderr.txt"), "warning line\n");

		const vm = loadMissionControlViewModel(process.cwd(), { root });

		expect(vm.missions[0].detailOutput).toMatchObject({ label: "Active worker transcript tail (run-active)", source: "transcript" });
		expect(vm.missions[0].detailOutput.text).toContain("Live transcript tail: showing 1 recent event");
		expect(vm.missions[0].detailOutput.text).toContain("assistant: working on it | tool bash");
		expect(vm.missions[0].detailOutput.secondary?.[0]).toMatchObject({ label: "Active worker stderr tail (run-active)", source: "stderr" });
	});

	it("falls back to block artifacts, completion reports, objectives, and next-step context", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-vm-"));
		tmpRoots.push(root);
		const blocked = mission("blocked", "blocked", { latestBlock: { ...block, runDir: path.join(root, "blocked", "runs", "run-blocked"), artifactPaths: [] } });
		const complete = mission("complete", "complete", {
			milestones: [{
				id: "M1",
				title: "Milestone",
				status: "complete",
				features: [{ id: "F1", title: "Done", description: "", status: "complete", validationRunId: "run-validation" }],
			}],
		});
		const planned = mission("planned", "planned");
		const pausedNoObjective = mission("paused", "paused");
		for (const state of [blocked, complete, planned, pausedNoObjective]) {
			fs.mkdirSync(path.join(root, state.id), { recursive: true });
			fs.writeFileSync(path.join(root, state.id, "mission.json"), JSON.stringify(state));
		}
		fs.mkdirSync(path.join(root, "blocked", "runs", "run-blocked"), { recursive: true });
		fs.writeFileSync(path.join(root, "blocked", "runs", "run-blocked", "handoff.md"), "# blocked handoff");
		fs.mkdirSync(path.join(root, "complete", "runs", "run-validation"), { recursive: true });
		fs.writeFileSync(path.join(root, "complete", "runs", "run-validation", "validation-report.md"), "# validation passed");
		fs.mkdirSync(path.join(root, "planned", "plan"), { recursive: true });
		fs.writeFileSync(path.join(root, "planned", "plan", "objective.md"), "# objective");

		const vm = loadMissionControlViewModel(process.cwd(), { root, includeClearedCompleted: true });
		const byId = Object.fromEntries(vm.missions.map((item) => [item.id, item]));

		expect(byId.blocked.detailOutput).toMatchObject({ label: "Current blocked run artifact (run-blocked)", source: "handoff" });
		expect(byId.complete.detailOutput).toMatchObject({ label: "Latest validation report (run-validation)", source: "validation-report" });
		expect(byId.planned.detailOutput).toMatchObject({ label: "Mission objective", source: "objective" });
		expect(byId.paused.detailOutput).toMatchObject({ label: "Next-step context", source: "next-step" });
	});
});
