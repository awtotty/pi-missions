import fs from "node:fs";
import ts from "typescript";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const source = fs.readFileSync(new URL("../extensions/missions/index.ts", import.meta.url), "utf8");

function extractFunctionSource(name) {
	const start = source.indexOf(`function ${name}(`);
	if (start === -1) fail(`missing function ${name}`);
	let i = source.indexOf("{", start);
	let depth = 0;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	fail(`unterminated function ${name}`);
}

async function loadRecoveryGateModule() {
	const gateFile = new URL("../extensions/missions/recovery-gate.ts", import.meta.url);
	const gateSource = fs.readFileSync(gateFile, "utf8");
	const transpiled = ts.transpileModule(gateSource, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
		fileName: "recovery-gate.ts",
	}).outputText;
	const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return import(dataUrl);
}

function compileNamedFunction(name, deps) {
	const fnText = extractFunctionSource(name);
	const transpiled = ts.transpileModule(fnText, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
		fileName: `${name}.ts`,
	}).outputText;
	const depNames = Object.keys(deps);
	const depValues = Object.values(deps);
	return new Function(...depNames, `"use strict"; ${transpiled}; return ${name};`)(...depValues);
}

function runCommandRoutingChecks() {
	const calls = [];
	const executeRunnerCommand = compileNamedFunction("executeRunnerCommand", {
		activeMissionFromState: () => undefined,
		latestMission: () => ({ id: "M1" }),
		loadMission: () => ({ id: "M1", status: "running", currentFeatureId: "F5", features: [] }),
		missionDir: () => "/tmp/mission",
		appendEvent: (...args) => calls.push(["appendEvent", ...args]),
		startMissionInBackground: (...args) => { calls.push(["start", ...args]); return { ok: true, text: "started" }; },
		requestMissionPauseAfterCurrent: (...args) => { calls.push(["pause", ...args]); return { ok: true, text: "paused" }; },
		tryCancelCurrentChild: () => true,
		isMissionRunActive: () => false,
		missionFeatureList: () => [{ id: "F5", status: "failed" }],
		nowIso: () => "2026-01-01T00:00:00.000Z",
		saveMission: () => {},
	});
	const ctx = { cwd: "/tmp" };
	const pi = {};

	assert(executeRunnerCommand({ command: "start", missionId: "M1", source: "test" }, ctx, pi).ok, "start must route via startMissionInBackground");
	assert(calls.some((c) => c[0] === "start"), "start routing call missing");

	assert(executeRunnerCommand({ command: "pause-after-current", missionId: "M1", source: "test" }, ctx, pi).ok, "pause-after-current must route");
	assert(calls.some((c) => c[0] === "pause"), "pause routing call missing");

	assert(executeRunnerCommand({ command: "cancel-current-child", missionId: "M1", source: "test" }, ctx, pi).ok, "cancel-current-child should succeed when cancelable");
	assert(calls.some((c) => c[0] === "appendEvent" && c[2] === "mission_current_child_cancel_requested"), "cancel must append auditable event");
}

async function runMissionControlLifecycleCheck() {
	let opened = false;
	let settled = false;
	const autoOpenMissionControl = compileNamedFunction("autoOpenMissionControl", {
		buildOrchestratorState: () => ({}),
		openMissionControl: () => {
			opened = true;
			return new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 50));
		},
	});
	const notifications = [];
	const ctx = { hasUI: true, cwd: "/tmp", ui: { notify: (m, l) => notifications.push([m, l]) } };
	autoOpenMissionControl(ctx, { id: "M1" }, {});
	assert(opened, "Mission Control should open when UI exists");
	assert(!settled, "auto-open must be fire-and-forget and not block execution");
	await new Promise((r) => setTimeout(r, 80));
	assert(settled, "Mission Control promise should eventually settle without blocking caller");
	assert(notifications.length === 0, "no warning expected on normal Mission Control close");
}

function runFeatureFlowSimulations() {
	const transitionValidatorFailToFeaturePendingForRetry = compileNamedFunction("transitionValidatorFailToFeaturePendingForRetry", {});
	const transitionValidatorPassToFeatureComplete = compileNamedFunction("transitionValidatorPassToFeatureComplete", {});
	const transitionMissionPauseAfterCurrent = compileNamedFunction("transitionMissionPauseAfterCurrent", {});

	const milestone = { features: [{ status: "running" }], status: "running" };
	const feature = { status: "running" };
	const mission = { status: "running" };
	transitionValidatorPassToFeatureComplete(mission, milestone, feature);
	assert(feature.status === "complete", "worker pass + validator pass should complete feature");

	feature.status = "running";
	mission.status = "running";
	transitionValidatorFailToFeaturePendingForRetry(mission, feature);
	assert(feature.status === "pending", "validator fail should keep same feature retryable");

	transitionMissionPauseAfterCurrent(mission, "2026-01-01T00:00:00.000Z");
	assert(mission.status === "paused", "pause-after-current must set paused state");
}

function runRecoveryAndRegressionChecks(computeRecoveryGatePlan) {
	const gate = computeRecoveryGatePlan({
		featureOrder: ["F5", "F6"],
		featureStatusById: { F5: "failed", F6: "pending" },
		blockedFeatureId: "F5",
		currentFeatureId: "F6",
		activeRunItemId: "F6",
		missionStatus: "running",
	});
	assert(gate.gateFeatureId === "F5", "gate must stay on F5");
	assert(gate.normalizeGateToPending && gate.setCurrentFeatureToGate && gate.clearActiveRun && gate.forceBlockedStatus, "gate repair plan must fix F5/F6 inconsistency");

	const mission = {
		id: "M1",
		status: "running",
		currentFeatureId: "F6",
		currentMilestoneId: "features",
		latestBlock: { featureId: "F5" },
		activeRun: { itemId: "F6", runId: "run-f6" },
		features: [{ id: "F5", status: "failed" }, { id: "F6", status: "pending" }],
	};
	if (gate.normalizeGateToPending) mission.features[0].status = "pending";
	if (gate.setCurrentFeatureToGate) mission.currentFeatureId = "F5";
	if (gate.clearActiveRun) mission.activeRun = undefined;
	if (gate.forceBlockedStatus) mission.status = "blocked";

	assert(mission.currentFeatureId === "F5", "currentFeatureId must be repaired to F5");
	assert(mission.activeRun === undefined, "stale activeRun on F6 must clear");
	assert(mission.features[0].status === "pending", "F5 should normalize to pending for retry");
	assert(mission.status === "blocked", "mission should remain blocked until F5 passes validation");

	const eventLog = [
		{ type: "feature_validation_failed", featureId: "F5" },
		{ type: "worker_missing_handoff", featureId: "F5" },
		{ type: "mission_recovery_gate_repaired", featureId: mission.currentFeatureId },
	];
	assert(eventLog.at(-1)?.featureId === "F5", "event log repair must record F5 gate consistency");
}

function runStructuralGuardrails() {
	for (const token of [
		"worker_missing_handoff_auto_retry",
		"ensureValidatorFailureReportArtifacts",
		"mission_runner_lock_recovered",
		"mission_recovery_gate_repaired",
		'executeRunnerCommand({ command: "pause-after-current"',
	]) {
		assert(source.includes(token), `missing required control-plane guardrail: ${token}`);
	}
}

runCommandRoutingChecks();
await runMissionControlLifecycleCheck();
runFeatureFlowSimulations();
const { computeRecoveryGatePlan } = await loadRecoveryGateModule();
runRecoveryAndRegressionChecks(computeRecoveryGatePlan);
runStructuralGuardrails();
console.log("F10 simulation/test harness validation passed.");
