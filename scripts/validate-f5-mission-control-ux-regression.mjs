import fs from "node:fs";
import ts from "typescript";

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

const source = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("runtime-extension.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function extractFunctionSource(name) {
	for (const stmt of sourceFile.statements) {
		if (!ts.isFunctionDeclaration(stmt) || !stmt.name || stmt.name.text !== name) continue;
		return stmt.getText(sourceFile);
	}
	fail(`missing function ${name}`);
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

function buildView() {
	return {
		showHelp: false,
		focusedPane: "features",
		scrollOffsets: { features: 0, details: 0, activity: 0, "child-output": 0 },
		viewMode: "dashboard",
		childOutputMode: "summary",
		selectedActivityIndexFromEnd: 0,
	};
}

function runResponsiveChecks() {
	const missionControlLayoutMode = compileNamedFunction("missionControlLayoutMode", {});
	assert(missionControlLayoutMode(120) === "wide", "wide breakpoint failed");
	assert(missionControlLayoutMode(90) === "medium", "medium breakpoint failed");
	assert(missionControlLayoutMode(62) === "narrow", "narrow breakpoint failed");
	assert(missionControlLayoutMode(61) === "compact", "compact breakpoint failed");

	const missionControlFooter = compileNamedFunction("missionControlFooter", {
		createMissionControlViewState: buildView,
		classifyMissionRunLifecycle: () => ({ state: "running" }),
	});
	const compact = missionControlFooter(40, { ...buildView(), focusedPane: "features" }, { kind: "feature" }, { cwd: "/tmp" });
	assert(compact.includes("q close") && compact.includes("tab/shift-tab") && compact.includes("scope feature"), "compact footer missing key hints");
}

function runFocusAndKeyHintChecks() {
	const missionControlPaneJump = compileNamedFunction("missionControlPaneJump", {});
	assert(missionControlPaneJump("1") === "features", "pane jump 1 failed");
	assert(missionControlPaneJump("4") === "child-output", "pane jump 4 failed");

	const missionControlHelpLines = compileNamedFunction("missionControlHelpLines", {});
	const help = missionControlHelpLines().join("\n");
	for (const expected of ["tab / shift-tab", "1-4 jump", "summary/raw/stderr", "q/esc: close Mission Control only"]) {
		assert(help.includes(expected), `help missing: ${expected}`);
	}

	const moveMissionControlFocus = compileNamedFunction("moveMissionControlFocus", {
		MISSION_CONTROL_PANES: ["features", "details", "activity", "child-output"],
	});
	assert(moveMissionControlFocus("features", 1) === "details", "tab focus advance failed");
	assert(moveMissionControlFocus("features", -1) === "child-output", "shift-tab focus wrap failed");
}

async function runStartSafetyAndDispatchChecks() {
	const sent = [];
	let closed = 0;
	const timers = [];
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, delay, ...args) => {
		timers.push({ fn, delay, args });
		return 1;
	};
	try {
		const dispatchMissionControlInput = compileNamedFunction("dispatchMissionControlInput", {
			matchesKey: () => false,
			moveMissionControlFocus: (pane, delta) => {
				const order = ["features", "details", "activity", "child-output"];
				const idx = order.indexOf(pane);
				return order[(idx + delta + order.length) % order.length];
			},
			missionControlPaneJump: (data) => ({ "1": "features", "2": "details", "3": "activity", "4": "child-output" })[data],
			missionControlAvailableActions: () => [{ id: "start-resume", key: "s" }],
			matchesMissionControlActionKey: (data, action) => data === action.key,
			dispatchMissionControlAction: async () => true,
			missionControlInputMoveDelta: () => 0,
			missionControlScrollDelta: () => 0,
			missionActivityViewModel: () => ({ events: [] }),
			moveMissionControlSelection: () => undefined,
			missionControlMoveRecentMission: () => undefined,
			cycleChildOutputMode: (mode) => mode,
		});

		const view = buildView();
		dispatchMissionControlInput("s", {
			ctx: { ui: { notify: () => {} }, cwd: "/tmp" },
			pi: { sendUserMessage: (msg) => sent.push(msg) },
			view,
			active: { id: "M1" },
			close: () => { closed += 1; },
			requestRender: () => {},
		});
		assert(closed === 1, "start-resume must close Mission Control first");
		assert(sent.length === 0, "start-resume must defer mission run send");
		assert(timers.length === 1 && timers[0].delay === 25, "start-resume should schedule async run");
		timers[0].fn(...timers[0].args);
		assert(sent[0] === "/missions run M1", "start-resume should queue /missions run for target mission");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

function runStaleStateChecks() {
	const missionControlLines = compileNamedFunction("missionControlLines", {
		missionControlTarget: (_cwd, _state, target) => ({ id: target ?? "M1", cwd: "/tmp", status: "running" }),
		visibleMissions: () => [],
		fitToViewport: (lines) => lines,
		latestBlockFromArtifacts: (mission) => mission.latestBlock,
		blockSelectionId: (block) => `block:${block.runId}`,
		missionControlSelectionById: (_mission, selectedId, block) => ({ kind: block ? "block" : "feature", id: selectedId ?? "F1" }),
		selectionId: (selection) => selection.id,
		missionControlFocusText: () => "focus",
		missionControlDashboardLines: () => ["dashboard"],
		missionControlHelpLines: () => [],
		missionControlFooter: () => "footer",
	});
	const view = buildView();
	const linesWithBlock = missionControlLines("/tmp", undefined, 80, undefined, view, "M1");
	assert(linesWithBlock.includes("dashboard"), "mission control lines should render active dashboard");

	// simulate stale block clear path
	view.lastAutoFocusedBlockId = "block:run-1";
	const missionControlLinesNoBlock = compileNamedFunction("missionControlLines", {
		missionControlTarget: () => ({ id: "M1", cwd: "/tmp", status: "running" }),
		visibleMissions: () => [],
		fitToViewport: (lines) => lines,
		latestBlockFromArtifacts: () => undefined,
		blockSelectionId: (block) => `block:${block.runId}`,
		missionControlSelectionById: () => ({ kind: "feature", id: "F1" }),
		selectionId: (selection) => selection.id,
		missionControlFocusText: () => "focus",
		missionControlDashboardLines: () => ["dashboard"],
		missionControlHelpLines: () => [],
		missionControlFooter: () => "footer",
	});
	missionControlLinesNoBlock("/tmp", undefined, 80, undefined, view, "M1");
	assert(view.lastAutoFocusedBlockId === undefined, "stale block focus marker should clear when block disappears");

	const updateWidget = compileNamedFunction("updateWidget", {
		missionFeatureList: () => [{ status: "pending" }],
		currentOrLastRunContext: () => undefined,
		classifyMissionRunLifecycle: () => ({ state: "idle" }),
		isMissionCleared: () => false,
	});
	const statusCalls = [];
	updateWidget({ ui: { setWidget: () => {}, setStatus: (_name, value) => statusCalls.push(value) } }, { cwd: "/tmp", id: "M1", status: "complete" });
	assert(statusCalls[0] === undefined, "status should be cleared before early return on completed/cleared mission");
}

runResponsiveChecks();
runFocusAndKeyHintChecks();
await runStartSafetyAndDispatchChecks();
runStaleStateChecks();

const dispatchStart = source.indexOf("function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {");
const dispatchEnd = dispatchStart >= 0 ? source.indexOf("\n}\n\nasync function openMissionControl", dispatchStart) : -1;
const dispatchBody = dispatchStart >= 0 && dispatchEnd > dispatchStart ? source.slice(dispatchStart, dispatchEnd) : "";
assert(dispatchBody.length > 0 && !dispatchBody.includes("ctx.ui.confirm(") && !dispatchBody.includes("context.ctx.ui.confirm("), "dispatch path must not use ctx.ui.confirm");

console.log("F5 Mission Control UX regression validation passed.");