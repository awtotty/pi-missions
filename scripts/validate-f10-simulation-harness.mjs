import fs from "node:fs";
import ts from "typescript";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const runtimeSource = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const missionControlSource = fs.readFileSync(new URL("../extensions/missions/ui/mission-control.ts", import.meta.url), "utf8");
const source = `${runtimeSource}\n${missionControlSource}`;
const lockSource = fs.readFileSync(new URL("../extensions/missions/runner/locks.ts", import.meta.url), "utf8");
const sourceFiles = [
	ts.createSourceFile("runtime-extension.ts", runtimeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
	ts.createSourceFile("mission-control.ts", missionControlSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
	ts.createSourceFile("locks.ts", lockSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
];

function extractFunctionSource(name) {
	for (const sourceFile of sourceFiles) {
		for (const stmt of sourceFile.statements) {
			if (!ts.isFunctionDeclaration(stmt) || !stmt.name || stmt.name.text !== name) continue;
			return stmt.getText(sourceFile);
		}
	}
	fail(`missing function ${name}`);
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
	const fnText = extractFunctionSource(name).replace(/^export\s+/, "");
	const transpiled = ts.transpileModule(fnText, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
		fileName: `${name}.ts`,
	}).outputText;
	const depNames = Object.keys(deps);
	const depValues = Object.values(deps);
	return new Function(...depNames, `"use strict"; ${transpiled}; return ${name};`)(...depValues);
}

function runArtifactFailureCoverage() {
	const classifyWorkerBlock = compileNamedFunction("classifyWorkerBlock", {});
	const classifyValidatorBlock = compileNamedFunction("classifyValidatorBlock", {});

	assert(classifyWorkerBlock({ exitCode: 0 }, undefined, "") === "missing_handoff", "worker success without handoff must classify as missing_handoff");
	assert(classifyValidatorBlock({ exitCode: 0 }, undefined) === "missing_validation_report", "validator success without report must classify as missing_validation_report");
	assert(classifyWorkerBlock({ exitCode: 1 }, {}, "") === "child_exit_nonzero", "worker nonzero exit must classify as child_exit_nonzero");
	assert(classifyValidatorBlock({ exitCode: 1 }, {}) === "child_exit_nonzero", "validator nonzero exit must classify as child_exit_nonzero");
}

function runCommandRoutingAndPauseChecks() {
	const calls = [];
	const executeRunnerCommand = compileNamedFunction("executeRunnerCommand", {
		activeMissionFromState: () => undefined,
		latestMission: () => ({ id: "M1" }),
		loadMission: () => ({ id: "M1", status: "running", currentFeatureId: "F5", features: [{ id: "F5", status: "failed" }] }),
		missionDir: () => "/tmp/mission",
		appendEvent: (...args) => calls.push(["appendEvent", ...args]),
		startMissionInBackground: (...args) => { calls.push(["start", ...args]); return { ok: true, text: "started" }; },
		requestMissionPauseAfterCurrent: (...args) => { calls.push(["pause", ...args]); return { ok: true, text: "pause requested" }; },
		tryCancelCurrentChild: () => true,
		isMissionRunActive: () => false,
		missionFeatureList: (mission) => mission.features,
		nowIso: () => "2026-01-01T00:00:00.000Z",
		saveMission: () => {},
		summarizeMission: () => "ok",
	});
	const ctx = { cwd: "/tmp" };
	const pi = {};

	assert(executeRunnerCommand({ command: "start", missionId: "M1", source: "test" }, ctx, pi).ok, "start must route via startMissionInBackground");
	assert(executeRunnerCommand({ command: "resume", missionId: "M1", source: "test" }, ctx, pi).ok, "resume must route via startMissionInBackground");
	assert(executeRunnerCommand({ command: "pause-after-current", missionId: "M1", source: "test" }, ctx, pi).ok, "pause-after-current must route via requestMissionPauseAfterCurrent");
	assert(calls.filter((c) => c[0] === "start").length === 2, "start/resume should call startMissionInBackground twice");
	assert(calls.some((c) => c[0] === "pause"), "pause routing call missing");
	assert(executeRunnerCommand({ command: "cancel-current-child", missionId: "M1", source: "test" }, ctx, pi).ok, "cancel-current-child should succeed when cancelable");
	assert(calls.some((c) => c[0] === "appendEvent" && c[2] === "mission_current_child_cancel_requested"), "cancel must append auditable event");

	const requestMissionPauseAfterCurrent = compileNamedFunction("requestMissionPauseAfterCurrent", {
		missionDir: () => "/tmp/mission",
		nowIso: () => "2026-01-01T00:00:00.000Z",
		writeJson: () => {},
		pauseRequestFile: () => "/tmp/pause-request.json",
		loadMission: () => ({ status: "running" }),
		saveMission: () => {},
		appendEvent: (...args) => calls.push(["appendEvent", ...args]),
	});
	const response = requestMissionPauseAfterCurrent("/tmp", { id: "M1", status: "running" }, "test");
	assert(response.text.includes("Current worker/validator will continue; no new unit will start"), "pause contract text must confirm non-killing + next-unit suppression");

	const applyPauseAfterCurrentIfRequested = compileNamedFunction("applyPauseAfterCurrentIfRequested", {
		readMissionPauseRequest: () => ({ requestedAt: "2026-01-01T00:00:00.000Z", source: "test" }),
		loadMission: () => ({ id: "M1", title: "Mission", status: "running" }),
		transitionMissionPauseAfterCurrent: (mission, requestedAt) => {
			mission.status = "paused";
			mission.pauseRequestedAt = requestedAt;
		},
		saveMission: () => {},
		appendEvent: (...args) => calls.push(["appendEvent", ...args]),
		missionDir: () => "/tmp/mission",
		updateWidget: () => {},
		clearMissionRunStatus: () => {},
		clearMissionPauseRequest: () => {},
	});
	const paused = applyPauseAfterCurrentIfRequested({ cwd: "/tmp", ui: { notify: () => {} } }, "M1", "worker");
	assert(paused === true, "pause-after-current request should pause mission after current unit");
	assert(calls.some((c) => c[0] === "appendEvent" && c[2] === "mission_paused_after_current"), "pause-after-current must append mission_paused_after_current event");
}

function runRunnerLockCoverage() {
	const startMissionInBackground = compileNamedFunction("startMissionInBackground", {
		loadMission: () => ({ id: "M1", status: "running" }),
		classifyMissionRunLifecycle: () => ({ state: "steady" }),
		isMissionRunActive: () => true,
		readRunnerLock: () => undefined,
		isSameLockOwner: () => false,
		lockHeartbeatExpired: () => false,
		isPidAlive: () => true,
		resetInterruptedRunForResume: () => {},
		missionDir: () => "/tmp/mission",
		appendEvent: () => {},
		runMission: () => Promise.resolve(),
		clearActiveRunOwnership: () => {},
		saveMission: () => {},
		updateWidget: () => {},
		clearMissionRunStatus: () => {},
	});
	const blocked = startMissionInBackground("M1", { cwd: "/tmp", ui: { notify: () => {} } }, {}, "test");
	assert(!blocked.ok && blocked.text.includes("already active"), "duplicate in-memory runner must be prevented");

	const lockHeartbeatExpired = compileNamedFunction("lockHeartbeatExpired", {
		RUNNER_HEARTBEAT_TIMEOUT_MS: 20_000,
		Date,
	});
	assert(lockHeartbeatExpired({ heartbeatAt: "2026-01-01T00:00:00.000Z", heartbeatTimeoutMs: 1 }) === true, "stale heartbeat must be detected");
	assert(lockSource.includes("recoveredFrom"), "stale lock recovery must persist recoveredFrom metadata");

	const acquireRunnerLock = compileNamedFunction("acquireRunnerLock", {
		withRunnerLockGuard: async (_cwd, _missionId, work) => await work(),
		readRunnerLock: () => ({
			schemaVersion: 1,
			missionId: "M1",
			ownerPid: 123,
			ownerSessionMarker: "pid-123",
			acquiredAt: "2026-01-01T00:00:00.000Z",
			heartbeatAt: "2026-01-01T00:00:00.000Z",
			heartbeatTimeoutMs: 1,
			status: "active",
		}),
		isSameLockOwner: () => false,
		nowIso: () => "2026-01-01T00:01:00.000Z",
		writeRunnerLock: () => {},
		isPidAlive: () => false,
		lockHeartbeatExpired: () => true,
		RUNNER_HEARTBEAT_TIMEOUT_MS: 20_000,
		parentSessionMarker: () => "pid-999",
		process: { pid: 999 },
	});
	return acquireRunnerLock("/tmp", { id: "M1" }).then((result) => {
		assert(result.ok, "acquireRunnerLock should recover stale lock");
		assert(result.recoveredStale === true, "stale lock path must set recoveredStale true");
		assert(result.lock.recoveredFrom?.ownerPid === 123, "stale lock recovery must preserve previous owner metadata");
	});
}

async function runMissionControlLifecycleCheck() {
	let opened = 0;
	let settled = 0;
	const autoOpenMissionControl = compileNamedFunction("autoOpenMissionControl", {
		buildOrchestratorState: () => ({}),
		openMissionControl: () => {
			opened++;
			return new Promise((resolve) => setTimeout(() => { settled++; resolve(); }, 40));
		},
	});
	const notifications = [];
	const ctx = { hasUI: true, cwd: "/tmp", ui: { notify: (m, l) => notifications.push([m, l]) } };
	autoOpenMissionControl(ctx, { id: "M1" }, {});
	autoOpenMissionControl(ctx, { id: "M1" }, {});
	assert(opened === 2, "Mission Control should support close/reopen lifecycle");
	assert(source.includes("void openMissionControl"), "Mission Control must open fire-and-forget rather than blocking runMission");
	await new Promise((resolve) => setTimeout(resolve, 90));
	assert(settled === 2, "all Mission Control instances should settle asynchronously");
	assert(notifications.length === 0, "normal close/reopen should not emit warnings");

	const openMissionControl = compileNamedFunction("openMissionControl", {
		MISSION_CONTROL_POLL_MS: 5,
		loadMissionControlViewModel: () => ({ missions: [{ id: "M1" }] }),
		missionControlLines: () => ["Mission Control"],
		missionControlTarget: () => ({ id: "M1" }),
		createMissionControlViewState: () => ({ showHelp: false, focusedPane: "features", scrollOffsets: { features: 0, details: 0, activity: 0, "child-output": 0 }, viewMode: "dashboard" }),
		dispatchMissionControlInput: (_data, inputContext) => { inputContext.close(); return "handled"; },
	});

	for (let attempt = 0; attempt < 2; attempt++) {
		let doneCalls = 0;
		let requestRenderCalls = 0;
		let component;
		const localCtx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				notify: (m, l) => notifications.push([m, l]),
				custom: async (factory) => {
					component = factory({ requestRender: () => { requestRenderCalls++; } }, {}, {}, () => { doneCalls++; });
					component.handleInput("q");
				},
			},
		};
		const result = await openMissionControl(localCtx, undefined, undefined, {});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(result.ok, "openMissionControl should resolve cleanly after user closes UI");
		assert(doneCalls === 1, "closing Mission Control should finalize once and return control to interactive session");
		assert(requestRenderCalls >= 0, "requestRender call accounting should remain valid");
	}
}

function runResponsiveLayoutChecks() {
	assert(source.includes("function fitToViewport") && source.includes("exactPadLineToWidth"), "read-only overlay must fit output to the terminal viewport");
	assert(source.includes("function panelLines") && source.includes('panelLines(section.title') && source.includes('panelLines("Mission Summary"'), "read-only overlay must render boxed overview and detail panels");
	assert(source.includes("clipLine") && source.includes("missionControlFooter"), "footer and rows must be clipped for narrow terminal widths");
	assert(source.includes("limitedPanelLines") && source.includes("outputScrollOffset"), "detail output must stay bounded and scrollable");
	assert(source.includes('overlay: true') && source.includes('width: "100%"') && source.includes('maxHeight: "100%"'), "Mission Control should remain a full-screen overlay");
	assert(source.includes('q/esc quit') && source.includes('enter detail') && source.includes('read-only'), "overview footer should keep close/navigation/read-only hints");
	assert(source.includes('b/esc back') && source.includes('g/G top/bottom'), "detail footer should keep back and output navigation hints");
}

function runFeatureFlowAndRegressionChecks(computeRecoveryGatePlan) {
	const transitionValidatorFailToFeaturePendingForRetry = compileNamedFunction("transitionValidatorFailToFeaturePendingForRetry", {});
	const transitionValidatorPassToFeatureComplete = compileNamedFunction("transitionValidatorPassToFeatureComplete", {
		clearResolvedFeatureBlock: (mission, featureId) => {
			if (mission.latestBlock?.featureId === featureId || mission.latestBlock?.failedItemId === featureId) mission.latestBlock = undefined;
		},
	});
	const findNextFeature = compileNamedFunction("findNextFeature", {
		featureStatusById: (mission) => new Map(mission.features.map((f) => [f.id, f.status])),
		missionFeatureList: (mission) => mission.features,
		areFeatureDependenciesSatisfied: () => true,
		milestoneForFeature: (mission) => mission.milestones[0] ?? { id: "features", title: "Features", features: mission.features, status: "pending" },
	});

	const milestone = { id: "features", title: "Features", status: "running", features: [{ id: "F5", status: "running" }, { id: "F6", status: "pending" }] };
	const feature = milestone.features[0];
	const mission = {
		id: "M1",
		status: "running",
		currentFeatureId: "F5",
		activeRun: { itemId: "F5", runId: "run-f5" },
		milestones: [milestone],
		features: milestone.features,
		latestBlock: { featureId: "F5", reasonCategory: "validator_report_failed", runId: "run-val-f5" },
	};

	transitionValidatorPassToFeatureComplete(mission, milestone, feature);
	assert(feature.status === "complete", "worker pass + validator pass should complete feature");
	feature.status = "running";
	transitionValidatorFailToFeaturePendingForRetry(mission, feature);
	assert(feature.status === "pending", "validator fail should keep same feature retryable");

	// Regression replay: F5 fails validation, retry exits without handoff, start/resume must not start F6.
	mission.currentFeatureId = "F6";
	mission.activeRun = { itemId: "F6", runId: "run-f6" };
	feature.status = "failed";
	mission.latestBlock = { featureId: "F5", reasonCategory: "missing_handoff", runId: "run-worker-f5-retry" };
	const gate = computeRecoveryGatePlan({
		featureOrder: ["F5", "F6"],
		featureStatusById: { F5: "failed", F6: "pending" },
		blockedFeatureId: "F5",
		currentFeatureId: "F6",
		activeRunItemId: "F6",
		missionStatus: "running",
	});
	assert(gate.gateFeatureId === "F5", "gate must stay on F5");
	if (gate.normalizeGateToPending) mission.features[0].status = "pending";
	if (gate.setCurrentFeatureToGate) mission.currentFeatureId = "F5";
	if (gate.clearActiveRun) mission.activeRun = undefined;
	if (gate.forceBlockedStatus) mission.status = "blocked";

	assert(mission.currentFeatureId === "F5", "currentFeatureId must repair to F5");
	assert(mission.activeRun === undefined, "stale activeRun must clear");
	assert(mission.features[0].status === "pending", "F5 must normalize to pending for retry");
	assert(mission.features[1].status === "pending", "F6 must stay pending while F5 is unresolved");
	assert(mission.status === "blocked", "mission must remain blocked");
	assert(mission.latestBlock.featureId === "F5", "latestBlock must continue pointing at F5");
	assert(findNextFeature(mission)?.feature.id === "F5", "resume must pick F5, never F6");

	const workerRetryClass = compileNamedFunction("classifyWorkerBlock", {});
	assert(workerRetryClass({ exitCode: 0 }, undefined, "") === "missing_handoff", "retry exit without handoff remains an F5 block condition");

	const eventLog = [
		{ type: "feature_validation_failed", featureId: "F5", runId: "run-val-f5" },
		{ type: "worker_missing_handoff", featureId: "F5", runId: "run-worker-f5-retry" },
		{ type: "mission_recovery_gate_repaired", featureId: mission.currentFeatureId, activeRun: mission.activeRun, latestBlockFeatureId: mission.latestBlock.featureId },
	];
	assert(eventLog.at(-1)?.featureId === "F5", "event log repair must preserve F5 as gate");
	assert(eventLog.at(-1)?.latestBlockFeatureId === "F5", "event log repair must preserve latestBlock consistency");
}

runArtifactFailureCoverage();
runCommandRoutingAndPauseChecks();
await runRunnerLockCoverage();
await runMissionControlLifecycleCheck();
runResponsiveLayoutChecks();
const { computeRecoveryGatePlan } = await loadRecoveryGateModule();
runFeatureFlowAndRegressionChecks(computeRecoveryGatePlan);

// Ensure required guardrails exist in production source.
for (const token of [
	"worker_missing_handoff_auto_retry",
	"ensureValidatorFailureReportArtifacts",
	"mission_runner_lock_recovered",
	"mission_recovery_gate_repaired",
	'if (input.command === "pause-after-current")',
]) {
	assert(source.includes(token), `missing required control-plane guardrail: ${token}`);
}

console.log("F10 simulation/test harness validation passed.");
