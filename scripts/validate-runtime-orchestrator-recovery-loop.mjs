import fs from "node:fs";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const runtime = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const runtimeTypes = fs.readFileSync(new URL("../extensions/missions/runtime-types.ts", import.meta.url), "utf8");

function sliceBetween(startToken, endToken, label = startToken) {
	const start = runtime.indexOf(startToken);
	assert(start >= 0, `missing ${label}`);
	const end = endToken ? runtime.indexOf(endToken, start + startToken.length) : -1;
	assert(!endToken || end > start, `missing end marker for ${label}: ${endToken}`);
	return runtime.slice(start, endToken ? end : undefined);
}

function functionBody(name) {
	const startToken = `function ${name}`;
	const start = runtime.indexOf(startToken);
	assert(start >= 0, `missing function ${name}`);
	const next = runtime.indexOf("\nfunction ", start + startToken.length);
	return runtime.slice(start, next === -1 ? undefined : next);
}

function assertOrdered(source, tokens, label) {
	let cursor = -1;
	for (const token of tokens) {
		const next = source.indexOf(token, cursor + 1);
		assert(next > cursor, `${label} missing ordered token after ${cursor}: ${token}`);
		cursor = next;
	}
}

const runner = sliceBetween("class MissionExecutionRunner", "async function runMission", "MissionExecutionRunner");
const dispatch = functionBody("dispatchMissionBlockRecovery");
const prompt = functionBody("runtimeOrchestratorRecoveryPrompt");
const blockMessage = functionBody("formatMissionBlockMessage");
const packetWriter = functionBody("writeRecoveryPacket");
const noRunnableReport = functionBody("writeNoRunnablePendingWorkReport");
const missionControlDispatch = sliceBetween(
	"function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {",
	"async function openMissionControl",
	"dispatchMissionControlInput",
);

// Validation failures must stop the deterministic runner and route recovery only after the validator child returns.
assertOrdered(runner, [
	"const validatorBlock = await runValidator(this.ctx, mission, milestone, this.childSignal);",
	"clearMissionRunStatus(this.ctx);",
	"if (validatorBlock) await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, validatorBlock);",
	"return;",
], "scrutiny validation failure recovery routing");
assertOrdered(runner, [
	"const userTestingBlock = await runMilestoneUserTestingValidator(this.ctx, mission, milestone, this.childSignal);",
	"clearMissionRunStatus(this.ctx);",
	"if (userTestingBlock) await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, userTestingBlock);",
	"return;",
], "user-testing validation failure recovery routing");
assert(functionBody("classifyValidatorBlock").includes("return \"validator_report_failed\";"), "validator reports must classify as validator_report_failed recovery blocks");

// No-runnable pending work is a recoverable block and must write artifacts before routing to the runtime orchestrator.
assertOrdered(runner, [
	"const pending = incompleteFeatures(mission);",
	"transitionMissionNoRunnablePendingWorkToBlocked(mission);",
	"const block = writeNoRunnablePendingWorkReport(runDir, mission, pending);",
	"persistMissionBlock(this.dir, mission, block, \"no_runnable_pending_work\");",
	"clearMissionRunStatus(this.ctx);",
	"await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, block);",
	"return;",
], "no-runnable-work recovery routing");
assert(noRunnableReport.includes("unresolved-pending-work.json") && noRunnableReport.includes("unresolved-pending-work.md"), "no-runnable-work recovery must emit deterministic inspection artifacts");
assert(blockMessage.includes("no_runnable_pending_work") && blockMessage.includes("no feature is currently runnable"), "main/recovery block display must explain no-runnable-work blocks");

// Session dispatch must prefer an existing official orchestrator session, then create a new runtime session when controls support it.
assert(dispatch.includes("hasSessionSwitchControls(ctx)"), "dispatch must gate session routing on session controls");
assert(dispatch.includes("readOrchestratorSessionRecord(mission.cwd, mission.id)"), "dispatch must consult the official orchestrator session record");
assertOrdered(dispatch, [
	"const existingSessionPath = existing?.sessionPath && fs.existsSync(existing.sessionPath) ? existing.sessionPath : undefined;",
	"if (existingSessionPath)",
	"await ctx.switchSession(existingSessionPath",
	"reusedSession: true",
	"triggerTurn: true",
	"return;",
	"await ctx.newSession",
	"writeOrchestratorSessionRecord(mission.cwd, mission.id",
	"reusedSession: false",
	"triggerTurn: true",
], "existing-session reuse before new-session creation");
assert(dispatch.includes("Mission runtime orchestrator:"), "new session setup must identify the runtime orchestrator session");
assert(dispatch.includes("buildOrchestratorState(mission.cwd, mission"), "new session setup must seed official orchestrator state");

// Main chat remains a display-only fallback/visibility channel, never the default executor when runtime routing is possible.
assertOrdered(dispatch, [
	"pi.sendMessage({",
	"customType: \"missions-block-context\"",
	"recoveryDispatchTarget: controlsAvailable ? \"dedicated-runtime-orchestrator-session\" : \"main-chat-display-only\"",
	"triggerTurn: false",
], "main-chat display-only recovery copy");
assert(dispatch.includes("runtime_orchestrator_recovery_dispatch_unavailable") && dispatch.includes("fallback: \"main-chat-display-only\""), "dispatch must record explicit main-chat fallback when session controls are unavailable");
assert(blockMessage.includes("display-only visibility for human override") && blockMessage.includes("display-only fallback for human override"), "block message must describe main chat as display-only visibility/fallback");

// Recovery authority must forbid direct repository implementation edits by default while allowing mission metadata/control-state repair.
for (const expected of [
	"Do not edit repository implementation code by default",
	"Use mission tools/APIs",
	"mission metadata/control-state recovery",
	"resume, ask-user, leave-blocked, retry-repair, or rerun-validation",
]) assert(prompt.includes(expected), `recovery prompt missing: ${expected}`);
for (const expected of [
	"mayUseMissionTools: true",
	"mayReviseMissionMetadata: true",
	"mayEditRepositoryImplementation: false",
	"repositoryEditPolicy: \"forbidden-by-default\"",
	"missionControl: \"read-only-observability\"",
]) assert(packetWriter.includes(expected) || runtimeTypes.includes(expected), `recovery authority contract missing: ${expected}`);
assert(runtimeTypes.includes("export type MissionRecoveryDispatchTarget = \"dedicated-runtime-orchestrator-session\";"), "recovery dispatch target type must remain dedicated orchestrator only");
assert(runtimeTypes.includes("export type MissionRecoveryFallback = \"main-chat-display-only\";"), "recovery fallback type must remain main-chat display-only");

// Mission Control must remain read-only and free of mutation controls as part of recovery routing.
for (const expected of [
	"Mission Control is read-only",
	"read-only",
	"q/esc quit",
]) assert(runtime.includes(expected), `Mission Control read-only UI marker missing: ${expected}`);
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
]) assert(!missionControlDispatch.includes(forbidden), `Mission Control input dispatch must not expose mutation/control path: ${forbidden}`);

console.log("Runtime orchestrator recovery loop validation passed.");
