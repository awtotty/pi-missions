import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = fs.readFileSync(path.join(process.cwd(), "extensions/missions/runtime-extension.ts"), "utf8");

function functionBody(name: string): string {
	const start = runtimeSource.indexOf(`function ${name}`);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = runtimeSource.indexOf("\nfunction ", start + 1);
	return runtimeSource.slice(start, next === -1 ? undefined : next);
}

describe("runtime orchestrator recovery routing", () => {
	it("routes recoverable blocks to the dedicated runtime orchestrator session with a triggered turn when controls exist", () => {
		const dispatch = functionBody("dispatchMissionBlockRecovery");
		expect(dispatch).toContain("hasSessionSwitchControls(ctx)");
		expect(dispatch).toContain("ctx.switchSession(existingSessionPath");
		expect(dispatch).toContain("ctx.newSession");
		expect(dispatch).toContain("missions-runtime-orchestrator-recovery");
		expect(dispatch).toContain("dedicated-runtime-orchestrator-session");
		expect(dispatch).toContain("triggerTurn: true");
		expect(dispatch).toContain("runtime_orchestrator_recovery_dispatched");
	});

	it("keeps main chat as display-only visibility and fallback instead of default recovery execution", () => {
		const dispatch = functionBody("dispatchMissionBlockRecovery");
		const format = functionBody("formatMissionBlockMessage");
		expect(dispatch).toContain("customType: \"missions-block-context\"");
		expect(dispatch).toContain("triggerTurn: false");
		expect(dispatch).toContain("runtime_orchestrator_recovery_dispatch_unavailable");
		expect(dispatch).toContain("main-chat-display-only");
		expect(format).toContain("display-only visibility for human override");
		expect(format).not.toContain("Continue recovery in this main chat as the mission orchestrator");
	});

	it("sends recovery instructions that allow mission metadata/control repair but forbid repository edits by default", () => {
		const prompt = functionBody("runtimeOrchestratorRecoveryPrompt");
		expect(prompt).toContain("dedicated runtime orchestrator session");
		expect(prompt).toContain("Do not edit repository implementation code by default");
		expect(prompt).toContain("Use mission tools/APIs");
		expect(prompt).toContain("resume, ask-user, leave-blocked, retry-repair, or rerun-validation");
		expect(prompt).toContain("retry-limit exceeded");
	});

	it("dispatches only after blocking worker/validator units have returned and runner status is being cleared", () => {
		const runner = runtimeSource.slice(runtimeSource.indexOf("class MissionExecutionRunner"), runtimeSource.indexOf("async function runMission"));
		expect(runner).toContain("const workerBlock = await runWorker");
		expect(runner).toContain("const validatorBlock = await runValidator");
		expect(runner).toContain("const userTestingBlock = await runMilestoneUserTestingValidator");
		for (const blockName of ["workerBlock", "validatorBlock", "userTestingBlock"]) {
			const dispatchIndex = runner.indexOf(`await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, ${blockName})`);
			expect(dispatchIndex).toBeGreaterThan(0);
			const clearIndex = runner.lastIndexOf("clearMissionRunStatus(this.ctx)", dispatchIndex);
			expect(clearIndex).toBeGreaterThan(0);
			expect(clearIndex).toBeLessThan(dispatchIndex);
		}
		const runWorker = runtimeSource.slice(runtimeSource.indexOf("async function runWorker"), runtimeSource.indexOf("function completedFeatureReviewContext"));
		expect(runWorker).toContain("clearActiveRunOwnership(mission);\n\tsaveMission(mission.cwd, mission);");
		const runValidator = runtimeSource.slice(runtimeSource.indexOf("async function runValidator"), runtimeSource.indexOf("function ensureUserTestingFailureReportArtifacts"));
		expect(runValidator).toContain("clearActiveRunOwnership(mission);\n\tsaveMission(mission.cwd, mission);");
	});
});
