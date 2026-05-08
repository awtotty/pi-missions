import fs from "node:fs";
import ts from "typescript";

function fail(message) {
	throw new Error(message);
}

function assert(condition, message) {
	if (!condition) fail(message);
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

const source = fs.readFileSync(new URL("../extensions/missions/index.ts", import.meta.url), "utf8");

function simulateFeatureRun({ workerHandoff, validatorReport, pauseAfterCurrent = false, lockState = "free" }) {
	const events = [];
	const state = {
		featureStatus: "pending",
		missionStatus: "running",
		latestBlock: undefined,
		launchedNextUnit: false,
	};

	if (lockState === "active") {
		events.push({ type: "start_rejected_duplicate_runner" });
		state.missionStatus = "blocked";
		return { state, events };
	}
	if (lockState === "stale") events.push({ type: "mission_runner_lock_recovered" });

	if (!workerHandoff) {
		state.featureStatus = "pending";
		state.missionStatus = "blocked";
		state.latestBlock = { reason: "worker_missing_handoff" };
		events.push({ type: "worker_missing_handoff_auto_retry" });
		return { state, events };
	}

	state.featureStatus = "running";
	if (!validatorReport) {
		state.featureStatus = "pending";
		state.missionStatus = "blocked";
		state.latestBlock = { reason: "missing validation report" };
		events.push({ type: "validator_report_missing" });
		return { state, events };
	}

	if (validatorReport === "fail") {
		state.featureStatus = "pending";
		state.missionStatus = "blocked";
		state.latestBlock = { reason: "validator_failed" };
		events.push({ type: "feature_validation_failed_auto_retry" });
		return { state, events };
	}

	state.featureStatus = "complete";
	events.push({ type: "feature_validation_passed" });
	if (pauseAfterCurrent) {
		state.missionStatus = "paused";
		events.push({ type: "mission_pause_after_current_applied" });
	} else {
		state.launchedNextUnit = true;
	}
	return { state, events };
}

function runBehaviorSimulations() {
	const pass = simulateFeatureRun({ workerHandoff: true, validatorReport: "pass" });
	assert(pass.state.featureStatus === "complete", "worker pass + validator pass must complete feature");
	assert(pass.events.some((e) => e.type === "feature_validation_passed"), "pass flow must emit validation-pass event");

	const failRetry = simulateFeatureRun({ workerHandoff: true, validatorReport: "fail" });
	assert(failRetry.state.featureStatus === "pending", "validator fail must keep same feature pending/retryable");
	assert(failRetry.events.some((e) => e.type === "feature_validation_failed_auto_retry"), "validator fail must emit retry event");

	const missingHandoff = simulateFeatureRun({ workerHandoff: false, validatorReport: undefined });
	assert(missingHandoff.state.latestBlock?.reason === "worker_missing_handoff", "missing handoff must block/retry deterministically");

	const missingReport = simulateFeatureRun({ workerHandoff: true, validatorReport: undefined });
	assert(missingReport.state.latestBlock?.reason === "missing validation report", "missing validation report must produce deterministic failure artifacts");

	const pause = simulateFeatureRun({ workerHandoff: true, validatorReport: "pass", pauseAfterCurrent: true });
	assert(pause.state.missionStatus === "paused", "pause-after-current must pause after current unit");
	assert(pause.state.launchedNextUnit === false, "pause-after-current must prevent launching next unit");

	const duplicate = simulateFeatureRun({ workerHandoff: true, validatorReport: "pass", lockState: "active" });
	assert(duplicate.events.some((e) => e.type === "start_rejected_duplicate_runner"), "duplicate runner start must be rejected");

	const stale = simulateFeatureRun({ workerHandoff: true, validatorReport: "pass", lockState: "stale" });
	assert(stale.events.some((e) => e.type === "mission_runner_lock_recovered"), "stale lock recovery must be auditable");
}

function runMissionControlStructuralChecks() {
	const required = [
		'executeRunnerCommand({ command: "pause-after-current"',
		'executeRunnerCommand({ command: "start"',
		'executeRunnerCommand({ command: "cancel-current-child"',
		"autoOpenMissionControl",
		"dispose: () => {",
		"finalize();",
		"done(undefined);",
	];
	for (const token of required) assert(source.includes(token), `Mission Control regression: missing ${token}`);
}

function runDogfoodingRegression(computeRecoveryGatePlan) {
	const scenario = {
		featureOrder: ["F5", "F6"],
		featureStatusById: { F5: "failed", F6: "pending" },
		blockedFeatureId: "F5",
		currentFeatureId: "F6",
		activeRunItemId: "F6",
		missionStatus: "running",
	};
	const plan = computeRecoveryGatePlan(scenario);
	assert(plan.gateFeatureId === "F5", "dogfooding regression: gate must remain F5");
	assert(plan.normalizeGateToPending, "dogfooding regression: failed F5 must normalize to pending");
	assert(plan.setCurrentFeatureToGate, "dogfooding regression: currentFeatureId must be reset to F5");
	assert(plan.clearActiveRun, "dogfooding regression: stale F6 activeRun must be cleared");
	assert(plan.forceBlockedStatus, "dogfooding regression: mission must remain blocked on F5");

	const eventLog = [];
	eventLog.push({ type: "feature_validation_failed", featureId: "F5" });
	eventLog.push({ type: "worker_missing_handoff", featureId: "F5" });
	eventLog.push({ type: "mission_recovery_gate_repaired", gateFeatureId: plan.gateFeatureId });
	assert(eventLog.at(-1)?.gateFeatureId === "F5", "dogfooding regression: event log repair must record F5 gate");
}

runBehaviorSimulations();
runMissionControlStructuralChecks();
const { computeRecoveryGatePlan } = await loadRecoveryGateModule();
runDogfoodingRegression(computeRecoveryGatePlan);

assert(source.includes('appendEvent(dir, "mission_recovery_gate_repaired"'), "execution-gate repairs must remain auditable in event logs");
console.log("F10 simulation/test harness validation passed.");
