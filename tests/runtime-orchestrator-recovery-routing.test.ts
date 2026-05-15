import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = fs.readFileSync(path.join(process.cwd(), "extensions/missions/runtime-extension.ts"), "utf8");
const recoverySource = fs.readFileSync(path.join(process.cwd(), "extensions/missions/runner/recovery.ts"), "utf8");
const combinedSource = `${runtimeSource}\n${recoverySource}`;

function functionBody(name: string): string {
	const start = combinedSource.indexOf(`function ${name}`);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = combinedSource.indexOf("\nfunction ", start + 1);
	const nextExport = combinedSource.indexOf("\nexport function ", start + 1);
	const candidates = [next, nextExport].filter((index) => index > start);
	const end = candidates.length > 0 ? Math.min(...candidates) : undefined;
	return combinedSource.slice(start, end);
}

function sourceBetween(startToken: string, endToken: string): string {
	const start = runtimeSource.indexOf(startToken);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = runtimeSource.indexOf(endToken, start + startToken.length);
	expect(end).toBeGreaterThan(start);
	return runtimeSource.slice(start, end);
}

function expectOrdered(source: string, tokens: string[]): void {
	let cursor = -1;
	for (const token of tokens) {
		const next = source.indexOf(token, cursor + 1);
		expect(next, `missing ordered token after ${cursor}: ${token}`).toBeGreaterThan(cursor);
		cursor = next;
	}
}

describe("runtime orchestrator recovery routing", () => {
	it("routes recoverable blocks to the dedicated runtime orchestrator session with a triggered turn when controls exist", () => {
		const dispatch = functionBody("dispatchMissionBlockRecovery");
		expect(dispatch).toContain("hasSessionSwitchControls(ctx)");
		expect(dispatch).toContain("ctx.switchSession(existingSessionPath");
		expect(dispatch).toContain("ctx.newSession");
		expect(dispatch).toContain("missions-runtime-orchestrator-recovery");
		expect(dispatch).toContain("dedicated-runtime-orchestrator-session");
		expect(dispatch).toContain("injectRuntimeOrchestratorSkill(nextCtx)");
		expect(dispatch).toContain("triggerTurn: true");
		expect(dispatch).toContain("runtime_orchestrator_recovery_dispatched");
	});

	it("reuses an existing official orchestrator session before creating a new runtime session", () => {
		const dispatch = functionBody("dispatchMissionBlockRecovery");
		expect(dispatch).toContain("readOrchestratorSessionRecord(mission.cwd, mission.id)");
		expectOrdered(dispatch, [
			"const existingSessionPath = existing?.sessionPath && fs.existsSync(existing.sessionPath) ? existing.sessionPath : undefined;",
			"if (existingSessionPath)",
			"await ctx.switchSession(existingSessionPath",
			"reusedSession: true",
			"return;",
			"await ctx.newSession",
			"writeOrchestratorSessionRecord(mission.cwd, mission.id",
			"reusedSession: false",
		]);
		expect(dispatch).toContain("Mission runtime orchestrator:");
		expect(dispatch).toContain("buildOrchestratorState(mission.cwd, mission");
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
		const skillInjection = functionBody("runtimeOrchestratorSkillInjectionContent");
		const inject = recoverySource.slice(recoverySource.indexOf("async function injectRuntimeOrchestratorSkill"), recoverySource.indexOf("function runtimeOrchestratorRecoveryPrompt"));
		expect(prompt).toContain("dedicated runtime orchestrator session");
		expect(prompt).toContain("mission-orchestrator skill has been injected");
		expect(skillInjection).toContain("BASE_SKILLS.orchestrator");
		expect(skillInjection).toContain("Use the mission-orchestrator skill");
		expect(inject).toContain("missions-runtime-orchestrator-skill-injection");
		expect(inject).toContain("display: false");
		expect(prompt).toContain("Do not edit repository implementation code by default");
		expect(prompt).toContain("Use mission tools/APIs");
		expect(prompt).toContain("resume, ask-user, leave-blocked, retry-repair, or rerun-validation");
		expect(prompt).toContain("retry-limit exceeded");
	});

	it("dispatches only after blocking worker/validator units have returned and runner status is being cleared", () => {
		const runner = sourceBetween("class MissionExecutionRunner", "async function runMission");
		expect(runner).toContain("const workerBlock = await runWorker");
		expect(runner).toContain("const validatorBlock = await runValidator");
		expect(runner).toContain("const userTestingBlock = await runMilestoneUserTestingValidator");
		for (const blockName of ["workerBlock", "validatorBlock", "userTestingBlock"]) {
			const dispatchIndex = runner.indexOf(`await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, ${blockName}, buildOrchestratorState)`);
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

	it("routes validation failures and no-runnable-work blocks to recovery", () => {
		const runner = sourceBetween("class MissionExecutionRunner", "async function runMission");
		expectOrdered(runner, [
			"const validatorBlock = await runValidator(this.ctx, mission, milestone, this.childSignal);",
			"clearMissionRunStatus(this.ctx);",
			"if (validatorBlock) await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, validatorBlock, buildOrchestratorState);",
		]);
		expectOrdered(runner, [
			"const pending = incompleteFeatures(mission);",
			"transitionMissionNoRunnablePendingWorkToBlocked(mission);",
			"const block = writeNoRunnablePendingWorkReport(runDir, mission, pending);",
			"persistMissionBlock(this.dir, mission, block, \"no_runnable_pending_work\");",
			"clearMissionRunStatus(this.ctx);",
			"await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, block, buildOrchestratorState);",
		]);
		expect(functionBody("classifyValidatorBlock")).toContain("return \"validator_report_failed\";");
		expect(functionBody("writeNoRunnablePendingWorkReport")).toContain("unresolved-pending-work.json");
	});

	it("keeps Mission Control read-only without recovery mutation controls", () => {
		const dispatch = sourceBetween("function dispatchMissionControlInput", "async function openMissionControl");
		for (const forbidden of [
			"executeRunnerCommand",
			"clearCompletedMissions",
			"mission_start_execution",
			"mission_runner_command",
			"sendUserMessage",
			"ctx.ui.confirm",
			"pause-after-current",
			"cancel-current",
			"mission_write_plan",
		]) {
			expect(dispatch).not.toContain(forbidden);
		}
		expect(runtimeSource).toContain("Mission Control is read-only");
	});
});
