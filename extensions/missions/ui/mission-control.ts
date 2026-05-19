import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadMissionControlViewModel, type MissionControlMissionView, type MissionControlOutputView, type MissionControlSectionView, type MissionControlViewModel } from "../core/mission-control-view-model.js";
import type { MissionCommandResult, MissionOrchestratorSessionState, Status } from "../runtime-types.js";

export type MissionControlOverlayMode = "overview" | "detail";

export interface MissionControlViewState {
	selectedMissionId?: string;
	mode: MissionControlOverlayMode;
	outputScrollOffset: number;
	showHelp: boolean;
}

export function createMissionControlViewState(): MissionControlViewState {
	return { mode: "overview", outputScrollOffset: 0, showHelp: false };
}

const MISSION_CONTROL_POLL_MS = 1500;

function clipLine(line: string, width: number): string {
	// Leave a one-column guard for terminal/wcwidth disagreements around emoji and
	// ellipsis glyphs. Mission Control is embedded directly in the main TUI render;
	// a single over-wide custom line crashes the whole pi process.
	const limit = Math.max(1, width - 1);
	return truncateToWidth(line, limit);
}

function exactClipLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width));
}

function exactPadLineToWidth(line: string, width: number): string {
	const clipped = exactClipLine(line, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function dividerLine(label: string, width: number): string {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(4, safeWidth - 2);
	const title = ` ${label} `;
	const titleWidth = visibleWidth(title);
	const remaining = Math.max(0, innerWidth - titleWidth);
	const left = "─".repeat(Math.floor(remaining / 2));
	const right = "─".repeat(Math.ceil(remaining / 2));
	return exactClipLine(`┌${left}${title}${right}┐`, safeWidth);
}

function panelLines(title: string, body: string[], width: number): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 2);
	const header = dividerLine(title, safeWidth);
	const clippedBody = body.length > 0 ? body.map((line) => exactClipLine(line, innerWidth)) : [exactClipLine("(no data)", innerWidth)];
	return [header, ...clippedBody.map((line) => exactClipLine(`│${exactPadLineToWidth(line, innerWidth)}│`, safeWidth)), exactClipLine(`└${"─".repeat(innerWidth)}┘`, safeWidth)];
}

function wrapLine(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(line) <= safeWidth) return [line];
	const words = line.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!word) continue;
		const candidate = `${current}${word}`;
		if (current && visibleWidth(candidate) > safeWidth) {
			lines.push(current.trimEnd());
			current = word.trimStart();
		} else {
			current = candidate;
		}
		if (visibleWidth(current) > safeWidth) {
			lines.push(exactClipLine(current, safeWidth));
			current = "";
		}
	}
	if (current.trim()) lines.push(current.trimEnd());
	return lines.length ? lines : [""];
}

function wrapLines(lines: string[], width: number): string[] {
	return lines.flatMap((line) => wrapLine(line, width));
}

function scrollWindow(lines: string[], offset: number, maxBodyLines: number): { body: string[]; maxOffset: number; clampedOffset: number } {
	const maxOffset = Math.max(0, lines.length - maxBodyLines);
	const clampedOffset = Math.max(0, Math.min(offset, maxOffset));
	const body = lines.slice(clampedOffset, clampedOffset + maxBodyLines);
	return { body, maxOffset, clampedOffset };
}

function limitedPanelLines(title: string, body: string[], width: number, maxPanelLines: number, offset = 0): { lines: string[]; maxOffset: number; clampedOffset: number } {
	const maxBodyLines = Math.max(1, maxPanelLines - 2);
	const windowed = scrollWindow(body, offset, maxBodyLines);
	const scrollTitle = windowed.maxOffset > 0 ? `${title} ${windowed.clampedOffset + 1}/${windowed.maxOffset + 1}` : title;
	const suffix = windowed.maxOffset > 0
		? [`… ${windowed.clampedOffset + 1}-${Math.min(body.length, windowed.clampedOffset + maxBodyLines)} / ${body.length}`]
		: [];
	return {
		lines: panelLines(scrollTitle, [...windowed.body, ...suffix], width),
		maxOffset: windowed.maxOffset,
		clampedOffset: windowed.clampedOffset,
	};
}

function missionControlStatusIcon(status: Status): string {
	if (status === "blocked" || status === "failed") return "!";
	if (status === "running") return "▶";
	if (status === "paused") return "Ⅱ";
	if (status === "complete") return "✓";
	return "○";
}

function missionControlItemStatusIcon(status: string): string {
	if (status === "failed") return "!";
	if (status === "running") return "▶";
	if (status === "complete") return "✓";
	if (status === "skipped") return "-";
	return "○";
}

function missionControlProgressBar(progress: { completed: number; total: number }, width: number): string {
	const total = Math.max(0, progress.total);
	const done = Math.max(0, Math.min(progress.completed, total));
	const barWidth = Math.max(4, Math.min(24, width));
	const filled = total === 0 ? 0 : Math.round((done / total) * barWidth);
	return `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}] ${done}/${total}`;
}

function missionControlMissionSummaryLines(mission: MissionControlMissionView, width: number, selected = false): string[] {
	const marker = selected ? "▸" : " ";
	const idLabel = mission.id.length > 34 ? `${mission.id.slice(0, 31)}…` : mission.id;
	const progress = missionControlProgressBar(mission.progress, Math.max(4, Math.min(18, width - 28)));
	return [
		clipLine(`${marker} ${missionControlStatusIcon(mission.status)} ${mission.status.toUpperCase()} ${mission.title}`, width),
		clipLine(`  ${idLabel} · ${mission.locationLabel}`, width),
		clipLine(`  Current: ${mission.currentTask}`, width),
		clipLine(`  ${progress}${mission.updatedAt ? ` · updated ${mission.updatedAt}` : ""}`, width),
	];
}

function selectedMissionView(vm: MissionControlViewModel, view: MissionControlViewState, targetMissionId?: string): MissionControlMissionView | undefined {
	const preferred = targetMissionId ?? view.selectedMissionId;
	const found = preferred ? vm.missions.find((mission) => mission.id === preferred) : undefined;
	return found ?? vm.missions[0];
}

function moveMissionControlOverviewSelection(vm: MissionControlViewModel, selectedId: string | undefined, delta: number): string | undefined {
	if (vm.missions.length === 0) return undefined;
	const current = Math.max(0, vm.missions.findIndex((mission) => mission.id === selectedId));
	const next = Math.max(0, Math.min(vm.missions.length - 1, current + delta));
	return vm.missions[next]?.id;
}

function missionControlOverviewLines(vm: MissionControlViewModel, view: MissionControlViewState, width: number): string[] {
	const selected = selectedMissionView(vm, view);
	if (selected) view.selectedMissionId = selected.id;
	const lines: string[] = ["Mission Control", ""];
	for (const section of vm.sections) {
		const body = missionControlSectionLines(section, selected?.id, Math.max(20, width - 4));
		lines.push(...panelLines(section.title, body.length ? body : ["No missions"], width), "");
	}
	if (view.showHelp) lines.push(...missionControlHelpLines(), "");
	lines.push(missionControlFooter(width, view));
	return lines;
}

function missionControlSectionLines(section: MissionControlSectionView, selectedId: string | undefined, width: number): string[] {
	return section.missions.flatMap((mission, index) => [
		...(index === 0 ? [] : [""]),
		...missionControlMissionSummaryLines(mission, width, mission.id === selectedId),
	]);
}

function missionControlDetailLines(mission: MissionControlMissionView, view: MissionControlViewState, width: number, height?: number): string[] {
	const summary = panelLines("Mission Summary", missionControlMissionSummaryLines(mission, Math.max(20, width - 4), true), width);
	const outline = panelLines("Mission Outline", missionControlOutlineLines(mission, Math.max(20, width - 4)), width);
	const output = wrapLines(missionControlOutputLines(mission.detailOutput), Math.max(20, width - 4));
	const fixedLines = 2 + summary.length + 1 + outline.length + 1 + 2 + (view.showHelp ? missionControlHelpLines().length + 1 : 0);
	const panelHeight = Math.max(5, (height ?? 30) - fixedLines);
	const rendered = limitedPanelLines(mission.detailOutput.label, output, width, panelHeight, view.outputScrollOffset);
	view.outputScrollOffset = rendered.clampedOffset;
	return [
		"Mission Control",
		"",
		...summary,
		"",
		...outline,
		"",
		...rendered.lines,
		...(view.showHelp ? ["", ...missionControlHelpLines()] : []),
		"",
		missionControlFooter(width, view),
	];
}

function missionControlOutlineLines(mission: MissionControlMissionView, width: number): string[] {
	if (mission.outline.length === 0) return ["No milestones defined."];
	return mission.outline.flatMap((milestone) => {
		const milestoneMarker = milestone.current ? "▸" : " ";
		const milestoneLine = clipLine(`${milestoneMarker} ${missionControlItemStatusIcon(milestone.status)} ${milestone.id}: ${milestone.title}`, width);
		const featureLines = milestone.features.map((feature, index) => {
			const branch = index === milestone.features.length - 1 ? "└─" : "├─";
			const featureMarker = feature.current ? "▸" : " ";
			return clipLine(`  ${branch} ${featureMarker} ${missionControlItemStatusIcon(feature.status)} ${feature.id}: ${feature.title}`, width);
		});
		return [milestoneLine, ...featureLines];
	});
}

function missionControlOutputLines(output: MissionControlOutputView): string[] {
	const primary = output.text.trim() ? output.text.split(/\r?\n/) : ["No output available."];
	const secondary = (output.secondary ?? []).flatMap((item) => ["", `--- ${item.label} ---`, ...(item.text.trim() ? item.text.split(/\r?\n/) : ["No output available."])]);
	return [...primary, ...secondary];
}

function missionControlHelpLines(): string[] {
	return [
		"Help",
		"Overview: ↑/↓ or j/k moves selection · enter opens detail",
		"Detail: b or escape returns to overview · ↑/↓ or j/k scroll output · g/G top/bottom",
		"Global: r refreshes artifacts · q quits Mission Control · ? toggles help",
		"Mission Control is read-only; start/resume/pause/cancel/clear stay in main chat/tools.",
	];
}

function missionControlFooter(width: number, view: MissionControlViewState): string {
	const text = view.mode === "detail"
		? "q quit · b/esc back · ↑/↓/j/k scroll output · g/G top/bottom · r refresh · ? help · read-only"
		: "q/esc quit · ↑/↓/j/k move · enter detail · r refresh · ? help · read-only";
	return clipLine(text, width);
}

function fitToViewport(lines: string[], width: number, height?: number): string[] {
	const filled = lines.map((line) => exactPadLineToWidth(line, width));
	const target = typeof height === "number" && Number.isFinite(height) ? Math.max(1, Math.floor(height)) : undefined;
	if (!target) return filled;
	if (filled.length >= target) return filled.slice(0, target);
	return [...filled, ...Array.from({ length: target - filled.length }, () => " ".repeat(Math.max(1, width)))];
}

export function missionControlLines(cwd: string, _state: MissionOrchestratorSessionState | undefined, width: number, height: number | undefined, view: MissionControlViewState, targetMissionId?: string): string[] {
	const safeWidth = Math.max(1, width);
	let vm: MissionControlViewModel;
	try {
		vm = loadMissionControlViewModel(cwd, { includeClearedCompleted: Boolean(targetMissionId) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fitToViewport(["Mission Control", "", `Could not load missions: ${message}`, "", "q/esc close"], safeWidth, height);
	}
	if (targetMissionId && !vm.missions.some((mission) => mission.id === targetMissionId)) {
		return fitToViewport(["Mission Control", "", `Mission not found: ${targetMissionId}`, "", "q/esc close"], safeWidth, height);
	}
	if (vm.missions.length === 0) {
		return fitToViewport(["Mission Control", "", "No visible missions found.", "Start one with /missions [goal].", "", missionControlFooter(safeWidth, view)], safeWidth, height);
	}
	const selected = selectedMissionView(vm, view, targetMissionId);
	if (selected) view.selectedMissionId = selected.id;
	if (targetMissionId) view.mode = "detail";
	const lines = view.mode === "detail" && selected
		? missionControlDetailLines(selected, view, safeWidth, height)
		: missionControlOverviewLines(vm, view, safeWidth);
	return fitToViewport(lines, safeWidth, height);
}

type MissionControlInputDispatchResult = "handled" | "ignored";

interface MissionControlInputDispatchContext {
	ctx: ExtensionContext;
	view: MissionControlViewState;
	targetMissionId?: string;
	close: () => void;
	requestRender: () => void;
}

function missionControlInputMoveDelta(data: string): number {
	if (data === "k" || matchesKey(data, "up") || data === "\u001b[A" || data === "\u001bOA") return -1;
	if (data === "j" || matchesKey(data, "down") || data === "\u001b[B" || data === "\u001bOB") return 1;
	return 0;
}

function missionControlScrollDelta(data: string): number {
	if (data === "\u001b[5~") return -10;
	if (data === "\u001b[6~") return 10;
	if (matchesKey(data, "ctrl+u")) return -5;
	if (matchesKey(data, "ctrl+d")) return 5;
	return 0;
}

function dispatchMissionControlInput(data: string, context: MissionControlInputDispatchContext): MissionControlInputDispatchResult {
	if (data === "q") {
		context.close();
		return "handled";
	}
	if (matchesKey(data, "escape")) {
		if (context.view.mode === "detail" && !context.targetMissionId) {
			context.view.mode = "overview";
			context.view.outputScrollOffset = 0;
			context.requestRender();
		} else {
			context.close();
		}
		return "handled";
	}
	if (data === "b" && context.view.mode === "detail" && !context.targetMissionId) {
		context.view.mode = "overview";
		context.view.outputScrollOffset = 0;
		context.requestRender();
		return "handled";
	}
	if (data === "?" ) {
		context.view.showHelp = !context.view.showHelp;
		context.requestRender();
		return "handled";
	}
	if (data === "r") {
		context.requestRender();
		return "handled";
	}
	if (matchesKey(data, "enter") && context.view.mode === "overview") {
		context.view.mode = "detail";
		context.view.outputScrollOffset = 0;
		context.requestRender();
		return "handled";
	}
	const moveBy = missionControlInputMoveDelta(data);
	if (moveBy !== 0) {
		if (context.view.mode === "detail") context.view.outputScrollOffset = Math.max(0, context.view.outputScrollOffset + moveBy);
		else {
			const vm = loadMissionControlViewModel(context.ctx.cwd);
			context.view.selectedMissionId = moveMissionControlOverviewSelection(vm, context.view.selectedMissionId, moveBy);
		}
		context.requestRender();
		return "handled";
	}
	const scrollBy = missionControlScrollDelta(data);
	if (scrollBy !== 0 && context.view.mode === "detail") {
		context.view.outputScrollOffset = Math.max(0, context.view.outputScrollOffset + scrollBy);
		context.requestRender();
		return "handled";
	}
	if (data === "g" && context.view.mode === "detail") {
		context.view.outputScrollOffset = 0;
		context.requestRender();
		return "handled";
	}
	if (data === "G" && context.view.mode === "detail") {
		context.view.outputScrollOffset = Number.MAX_SAFE_INTEGER;
		context.requestRender();
		return "handled";
	}
	return "ignored";
}

export async function openMissionControl(ctx: ExtensionContext, state: MissionOrchestratorSessionState | undefined, targetMissionId: string | undefined, _pi: ExtensionAPI): Promise<MissionCommandResult> {
	if (!ctx.hasUI) {
		const text = "Mission Control requires an interactive UI.";
		ctx.ui.notify(text, "warning");
		return { ok: false, text };
	}
	if (targetMissionId && !loadMissionControlViewModel(ctx.cwd, { includeClearedCompleted: true }).missions.some((mission) => mission.id === targetMissionId)) {
		const text = `Mission not found: ${targetMissionId}`;
		ctx.ui.notify(text, "warning");
		return { ok: false, text };
	}
	const view = createMissionControlViewState();
	await ctx.ui.custom((tui, _theme, _keybindings, done) => {
		let closed = false;
		const poll = setInterval(() => {
			if (!closed) tui.requestRender();
		}, MISSION_CONTROL_POLL_MS);
		const finalize = () => {
			if (closed) return;
			closed = true;
			clearInterval(poll);
			// Do not tear down the custom UI synchronously from inside its input
			// handler. Deferring done() lets the TUI finish dispatching the close key
			// before Mission Control is removed and focus is restored to the normal
			// editor, avoiding a stale custom focus/input sink after completed missions.
			setTimeout(() => {
				done(undefined);
			}, 0);
		};
		const close = () => {
			finalize();
		};
		return {
			render: (width: number) => missionControlLines(
				ctx.cwd,
				state,
				width,
				((tui as { terminal?: { rows?: number } }).terminal?.rows) ?? (tui as { rows?: number }).rows,
				view,
				targetMissionId,
			),
			invalidate: () => undefined,
			dispose: () => {
				finalize();
			},
			handleInput: (data: string) => {
				dispatchMissionControlInput(data, {
					ctx,
					view,
					targetMissionId,
					close,
					requestRender: () => {
						if (!closed) tui.requestRender();
					},
				});
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
			margin: 0,
		},
	});
	return { ok: true, text: "Mission Control closed." };
}
