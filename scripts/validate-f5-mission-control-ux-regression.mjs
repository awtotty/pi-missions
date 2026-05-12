import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");

const inputDispatchStart = source.indexOf("function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {");
const inputDispatchEnd = inputDispatchStart >= 0 ? source.indexOf("\n}\n\nasync function openMissionControl", inputDispatchStart) : -1;
const inputDispatchBody = inputDispatchStart >= 0 && inputDispatchEnd > inputDispatchStart ? source.slice(inputDispatchStart, inputDispatchEnd) : "";

const checks = [
	{
		id: "RESPONSIVE_LAYOUT_MODES",
		ok: source.includes('type MissionControlLayoutMode = "wide" | "medium" | "narrow" | "compact";')
			&& source.includes("if (width >= 120) return \"wide\";")
			&& source.includes("if (width >= 90) return \"medium\";")
			&& source.includes("if (width >= 62) return \"narrow\";")
			&& source.includes('return "compact";'),
		error: "Mission Control should preserve deterministic responsive layout breakpoints (wide/medium/narrow/compact).",
	},
	{
		id: "FOCUS_AND_PANE_MOVEMENT",
		ok: source.includes("const MISSION_CONTROL_PANES: MissionControlPaneId[] = [\"features\", \"details\", \"activity\", \"child-output\"];")
			&& source.includes("function missionControlPaneJump(data: string): MissionControlPaneId | undefined")
			&& source.includes('if (data === "\\t" || matchesKey(data, "tab"))')
			&& source.includes('if (data === "\\u001b[Z" || matchesKey(data, "shift+tab"))'),
		error: "Mission Control should keep explicit focus movement via tab/shift-tab and pane jump keys.",
	},
	{
		id: "STATUS_AND_FOOTER_CONTEXT",
		ok: source.includes("ctx.ui.setStatus(\"missions\", undefined);")
			&& source.includes("function missionControlFooter(width: number, view?: MissionControlViewState, selection?: MissionControlSelection, mission?: MissionState): string")
			&& source.includes('if (pane === "features") return `${base} · ↑/↓ select · scope ${scope} · ${lifecycle}`;')
			&& source.includes('return `${base} · child output inspect · o mode ${effectiveView.childOutputMode} · ${lifecycle}`;'),
		error: "Mission status/footer rendering should clear stale status and keep pane-aware footer hints.",
	},
	{
		id: "START_SAFETY_OUTSIDE_OVERLAY",
		ok: source.includes('if (matchedAction.id === "start-resume")')
			&& source.includes("context.close();")
			&& source.includes("setTimeout(() => {")
			&& source.includes("context.pi.sendUserMessage(`/missions run ${missionId}`);")
			&& source.includes("overlay: true,"),
		error: "Mission Control start/resume must close overlay first and queue /missions run asynchronously.",
	},
	{
		id: "NO_MODAL_CONFIRM_IN_INPUT_LOOP",
		ok: inputDispatchBody.length > 0 && !inputDispatchBody.includes("ctx.ui.confirm(") && !inputDispatchBody.includes("context.ctx.ui.confirm("),
		error: "Mission Control input handling must not use modal ctx.ui.confirm.",
	},
	{
		id: "STALE_BLOCK_AND_SELECTION_HANDLING",
		ok: source.includes("const block = latestBlockFromArtifacts(active);")
			&& source.includes("if (view.lastAutoFocusedBlockId !== id)")
			&& source.includes("view.lastAutoFocusedBlockId = undefined;")
			&& source.includes("missionControlSelectionById(active, view.selectedId, block)"),
		error: "Block auto-focus and selection fallback should avoid stale block/selection indicators.",
	},
	{
		id: "KEY_HINT_AND_HELP_MODEL",
		ok: source.includes("function missionControlHelpLines(): string[]")
			&& source.includes('"Focus panes: tab / shift-tab, or 1-4 jump (Features, Details, Activity, Child Output)"')
			&& source.includes('"o: cycle child output mode (summary/raw/stderr)"')
			&& source.includes('"q/esc: close Mission Control only"'),
		error: "Help and key-hint model should include pane focus, child output mode, and close semantics.",
	},
];

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
	console.error("F5 Mission Control UX regression validation failed:");
	for (const check of failed) console.error(`- [${check.id}] ${check.error}`);
	process.exit(1);
}

console.log("F5 Mission Control UX regression validation passed.");
for (const check of checks) console.log(`- [${check.id}] ok`);
