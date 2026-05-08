import fs from "node:fs";
import ts from "typescript";

function fail(message) {
	throw new Error(message);
}

async function loadRecoveryGateModule() {
	const gateFile = new URL("../extensions/missions/recovery-gate.ts", import.meta.url);
	const gateSource = fs.readFileSync(gateFile, "utf8");
	const transpiled = ts.transpileModule(gateSource, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
		fileName: "recovery-gate.ts",
	}).outputText;
	const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return import(dataUrl);
}

const source = fs.readFileSync(new URL("../extensions/missions/index.ts", import.meta.url), "utf8");

const staticChecks = [
	{
		name: "worker pass + validator pass path",
		ok: source.includes('if (result.exitCode === 0 && report?.status === "pass")')
			&& source.includes("transitionValidatorPassToFeatureComplete"),
	},
	{
		name: "worker pass + validator fail + retry signal",
		ok: source.includes("feature_validation_failed_auto_retry")
			&& source.includes('if (input.command === "retry-feature")')
			&& source.includes("normalizeBlockedFeatureForRetry"),
	},
	{
		name: "missing handoff recovery path",
		ok: source.includes("worker_missing_handoff_auto_retry")
			&& source.includes("status: handoff?.status ?? (!handoff ? \"missing handoff\" : undefined)"),
	},
	{
		name: "missing validation report recovery path",
		ok: source.includes("missing validation report")
			&& source.includes("ensureValidatorFailureReportArtifacts"),
	},
	{
		name: "pause-after-current semantics",
		ok: source.includes("Pause-after-current requested")
			&& source.includes("applyPauseAfterCurrentIfRequested"),
	},
	{
		name: "duplicate runner prevention",
		ok: source.includes("if (ACTIVE_MISSION_RUNS.has(runKey))")
			&& source.includes("Mission execution is already active for this mission."),
	},
	{
		name: "stale lock recovery",
		ok: source.includes("mission_runner_lock_recovered")
			&& source.includes("recoveredStale")
			&& source.includes("recoveredFrom"),
	},
	{
		name: "Mission Control command routing",
		ok: source.includes('executeRunnerCommand({ command: "pause-after-current"')
			&& source.includes('executeRunnerCommand({ command: "start"')
			&& source.includes('executeRunnerCommand({ command: "cancel-current-child"'),
	},
	{
		name: "Mission Control lifecycle handoff back to interactive loop",
		ok: source.includes("autoOpenMissionControl")
			&& source.includes("dispose: () => {")
			&& source.includes("finalize();")
			&& source.includes("done(undefined);"),
	},
];

const staticFailures = staticChecks.filter((check) => !check.ok);
if (staticFailures.length) {
	for (const failure of staticFailures) fail(`F10 static regression failed: ${failure.name}`);
}

const { computeRecoveryGatePlan } = await loadRecoveryGateModule();

const simulatedScenarios = [
	{
		name: "validator fail keeps same feature as gate",
		input: {
			featureOrder: ["F5", "F6"],
			featureStatusById: { F5: "failed", F6: "pending" },
			blockedFeatureId: "F5",
			currentFeatureId: "F6",
			activeRunItemId: "F6",
			missionStatus: "running",
		},
		expect: {
			gateFeatureId: "F5",
			normalizeGateToPending: true,
			setCurrentFeatureToGate: true,
			clearActiveRun: true,
			forceBlockedStatus: true,
		},
	},
	{
		name: "missing handoff keeps retry gate on same feature",
		input: {
			featureOrder: ["F5", "F6"],
			featureStatusById: { F5: "pending", F6: "pending" },
			blockedFeatureId: "F5",
			currentFeatureId: "F6",
			activeRunItemId: "F6",
			missionStatus: "blocked",
		},
		expect: {
			gateFeatureId: "F5",
			setCurrentFeatureToGate: true,
			clearActiveRun: true,
			forceBlockedStatus: false,
		},
	},
	{
		name: "dogfooding regression: F5 validation fail then retry exits without handoff must not advance to F6",
		input: {
			featureOrder: ["F5", "F6"],
			featureStatusById: { F5: "failed", F6: "pending" },
			blockedFeatureId: "F5",
			currentFeatureId: "F6",
			activeRunItemId: "F6",
			missionStatus: "running",
		},
		expect: {
			gateFeatureId: "F5",
			normalizeGateToPending: true,
			setCurrentFeatureToGate: true,
			clearActiveRun: true,
			forceBlockedStatus: true,
		},
	},
];

for (const scenario of simulatedScenarios) {
	const plan = computeRecoveryGatePlan(scenario.input);
	for (const [key, value] of Object.entries(scenario.expect)) {
		if (plan[key] !== value) {
			fail(`F10 simulation failed (${scenario.name}): expected ${key}=${value} but got ${plan[key]}`);
		}
	}
}

if (!source.includes('appendEvent(dir, "mission_recovery_gate_repaired"')) {
	fail("F10 regression failed: execution-gate repairs must remain auditable in event logs.");
}

console.log("F10 simulation/test harness validation passed.");
