import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "./json.js";
import { clearedMissionsFile, missionRoot } from "./paths.js";
import type { ClearedMissionsState, MissionBlockMetadata, MissionFeature, MissionMilestone, MissionState, Status } from "../runtime-types.js";

export type MissionControlSectionId = "blockedFailed" | "running" | "paused" | "planned" | "completed";

export interface MissionControlProgressView {
	completed: number;
	total: number;
}

export interface MissionControlOutputView {
	label: string;
	source: "transcript" | "stderr" | "block-artifact" | "validation-report" | "handoff" | "objective" | "next-step" | "none";
	text: string;
	path?: string;
	secondary?: MissionControlOutputView[];
}

export interface MissionControlMissionView {
	id: string;
	title: string;
	status: Status;
	cwd: string;
	cwdLabel: string;
	repoLabel: string;
	worktreeLabel?: string;
	locationLabel: string;
	currentTask: string;
	progress: MissionControlProgressView;
	activeRun?: MissionState["activeRun"];
	currentMilestoneId?: string;
	currentFeatureId?: string;
	currentBlock?: MissionBlockMetadata;
	detailOutput: MissionControlOutputView;
	updatedAt?: string;
}

export interface MissionControlSectionView {
	id: MissionControlSectionId;
	title: string;
	missions: MissionControlMissionView[];
}

export interface MissionControlViewModel {
	sections: MissionControlSectionView[];
	missions: MissionControlMissionView[];
}

export const MISSION_CONTROL_SECTION_ORDER: Array<{ id: MissionControlSectionId; title: string; statuses: Status[] }> = [
	{ id: "blockedFailed", title: "Blocked / Failed", statuses: ["blocked", "failed"] },
	{ id: "running", title: "Running", statuses: ["running"] },
	{ id: "paused", title: "Paused", statuses: ["paused"] },
	{ id: "planned", title: "Planned", statuses: ["planning", "planned"] },
	{ id: "completed", title: "Completed", statuses: ["complete"] },
];

interface MissionWithDir { mission: MissionState; missionDir?: string }

export function loadMissionControlViewModel(cwd: string, options: { root?: string; includeClearedCompleted?: boolean } = {}): MissionControlViewModel {
	const root = options.root ?? missionRoot(cwd);
	const cleared = options.includeClearedCompleted ? new Set<string>() : loadClearedMissionIds(cwd, root);
	const missions = fs.existsSync(root)
		? fs.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({ missionDir: path.join(root, entry.name), file: path.join(root, entry.name, "mission.json") }))
			.filter((entry) => fs.existsSync(entry.file))
			.flatMap((entry) => {
				try { return [{ mission: readJson<MissionState>(entry.file), missionDir: entry.missionDir }]; } catch { return []; }
			})
			.filter((entry) => entry.mission.status !== "complete" || !cleared.has(entry.mission.id))
		: [];
	return createMissionControlViewModelFromEntries(missions);
}

export function createMissionControlViewModel(missions: MissionState[]): MissionControlViewModel {
	return createMissionControlViewModelFromEntries(missions.map((mission) => ({ mission })));
}

function createMissionControlViewModelFromEntries(entries: MissionWithDir[]): MissionControlViewModel {
	const missionViews = entries.map((entry) => createMissionControlMissionView(entry.mission, entry.missionDir));
	const sections = MISSION_CONTROL_SECTION_ORDER.map((section) => ({
		id: section.id,
		title: section.title,
		missions: missionViews
			.filter((mission) => section.statuses.includes(mission.status))
			.sort(compareMissionViews),
	}));
	return { sections, missions: sections.flatMap((section) => section.missions) };
}

export function createMissionControlMissionView(mission: MissionState, missionDir?: string): MissionControlMissionView {
	const allFeatures = flattenFeatures(mission);
	const progress = {
		completed: allFeatures.filter((feature) => feature.status === "complete" || feature.status === "skipped").length,
		total: allFeatures.length,
	};
	const labels = deriveLocationLabels(mission.cwd);
	const currentTask = deriveCurrentTask(mission, allFeatures);
	return {
		id: mission.id,
		title: mission.title,
		status: mission.status,
		cwd: mission.cwd,
		...labels,
		currentTask,
		progress,
		activeRun: mission.activeRun,
		currentMilestoneId: mission.currentMilestoneId,
		currentFeatureId: mission.currentFeatureId,
		currentBlock: mission.status === "blocked" || mission.status === "failed" ? mission.latestBlock : undefined,
		detailOutput: deriveDetailOutput(mission, allFeatures, currentTask, missionDir),
		updatedAt: mission.updatedAt,
	};
}

function deriveDetailOutput(mission: MissionState, allFeatures: MissionFeature[], currentTask: string, missionDir?: string): MissionControlOutputView {
	if ((mission.status === "blocked" || mission.status === "failed") && mission.latestBlock) {
		const artifact = firstReadableArtifact(mission.latestBlock.artifactPaths) ?? firstRunArtifact(mission.latestBlock.runDir, ["validation-report.md", "handoff.md", "stderr.txt", "transcript.jsonl"]);
		if (artifact) return { label: `Current ${mission.status} run artifact (${mission.latestBlock.runId})`, source: artifactSource(artifact), text: readTail(artifact), path: artifact };
		return { label: `Current ${mission.status} run (${mission.latestBlock.runId})`, source: "next-step", text: blockFallbackText(mission.latestBlock) };
	}

	if (mission.status === "running" && mission.activeRun && missionDir) {
		const runDir = path.join(missionDir, "runs", mission.activeRun.runId);
		const transcript = path.join(runDir, "transcript.jsonl");
		const stderr = path.join(runDir, "stderr.txt");
		const primary = fs.existsSync(transcript)
			? { label: `Active ${mission.activeRun.kind} transcript tail (${mission.activeRun.runId})`, source: "transcript" as const, text: readTranscriptTail(transcript), path: transcript }
			: undefined;
		const stderrView = fs.existsSync(stderr) && readTail(stderr).trim()
			? { label: `Active ${mission.activeRun.kind} stderr tail (${mission.activeRun.runId})`, source: "stderr" as const, text: readTail(stderr), path: stderr }
			: undefined;
		if (primary) return stderrView ? { ...primary, secondary: [stderrView] } : primary;
		if (stderrView) return stderrView;
	}

	if (mission.status === "complete" && missionDir) {
		const runId = latestValidationRunId(mission) ?? latestCompletedRunId(allFeatures);
		const artifact = runId ? firstRunArtifact(path.join(missionDir, "runs", runId), ["validation-report.md", "handoff.md"]) : undefined;
		if (artifact) return { label: artifact.endsWith("validation-report.md") ? `Latest validation report (${runId})` : `Completion handoff (${runId})`, source: artifactSource(artifact), text: readTail(artifact), path: artifact };
		return { label: "Completion summary", source: "next-step", text: "Mission complete." };
	}

	if ((mission.status === "planned" || mission.status === "planning" || mission.status === "paused") && missionDir) {
		const objective = path.join(missionDir, "plan", "objective.md");
		if (fs.existsSync(objective)) return { label: mission.status === "paused" ? "Paused mission objective / next-step context" : "Mission objective", source: "objective", text: readTail(objective), path: objective };
	}

	return { label: "Next-step context", source: "next-step", text: currentTask || "No detail output available." };
}

function firstReadableArtifact(paths: string[]): string | undefined { return paths.find((item) => item && fs.existsSync(item) && fs.statSync(item).isFile()); }
function firstRunArtifact(runDir: string, names: string[]): string | undefined { return names.map((name) => path.join(runDir, name)).find((item) => fs.existsSync(item)); }
function artifactSource(file: string): MissionControlOutputView["source"] { if (file.endsWith("stderr.txt")) return "stderr"; if (file.endsWith("transcript.jsonl")) return "transcript"; if (file.endsWith("validation-report.md")) return "validation-report"; if (file.endsWith("handoff.md")) return "handoff"; return "block-artifact"; }
function readTail(file: string, maxChars = 8000): string { try { const text = fs.readFileSync(file, "utf8"); return text.length > maxChars ? text.slice(-maxChars) : text; } catch { return ""; } }
function readTranscriptTail(file: string): string { return readTail(file).split(/\r?\n/).filter(Boolean).slice(-40).map((line) => { try { const parsed = JSON.parse(line) as { role?: string; content?: unknown; text?: unknown }; const content = typeof parsed.content === "string" ? parsed.content : typeof parsed.text === "string" ? parsed.text : line; return parsed.role ? `${parsed.role}: ${content}` : content; } catch { return line; } }).join("\n"); }
function latestValidationRunId(mission: MissionState): string | undefined { return [...(mission.milestones ?? [])].reverse().find((m) => m.validationRunId)?.validationRunId ?? [...flattenFeatures(mission)].reverse().find((f) => f.validationRunId)?.validationRunId; }
function latestCompletedRunId(features: MissionFeature[]): string | undefined { return [...features].reverse().find((f) => f.runId)?.runId; }
function blockFallbackText(block: MissionBlockMetadata): string { return [`${block.kind} ${block.failedItemId} failed with ${block.reasonCategory}.`, `Run: ${block.runId}`, `Exit code: ${block.exitCode}`, block.dirty ? `Dirty worktree: ${block.dirty}` : undefined].filter(Boolean).join("\n"); }

function loadClearedMissionIds(cwd: string, root: string): Set<string> {
	const file = root === missionRoot(cwd) ? clearedMissionsFile(cwd) : path.join(root, "cleared.json");
	try {
		const state = readJson<ClearedMissionsState>(file);
		return new Set(state.clearedMissionIds ?? []);
	} catch {
		return new Set();
	}
}

function flattenFeatures(mission: MissionState): MissionFeature[] {
	if (mission.milestones?.length) return mission.milestones.flatMap((milestone) => milestone.features ?? []);
	return mission.features ?? [];
}

function deriveCurrentTask(mission: MissionState, allFeatures: MissionFeature[]): string {
	if (mission.activeRun) return `${mission.activeRun.kind} ${mission.activeRun.itemId}`;
	const feature = allFeatures.find((item) => item.id === mission.currentFeatureId)
		?? allFeatures.find((item) => item.status === "running")
		?? allFeatures.find((item) => item.status === "failed")
		?? allFeatures.find((item) => item.status === "pending");
	if (feature) return `${feature.id}: ${feature.title}`;
	const milestone = (mission.milestones ?? []).find((item: MissionMilestone) => item.id === mission.currentMilestoneId)
		?? (mission.milestones ?? []).find((item) => item.status === "running" || item.status === "pending" || item.status === "failed");
	if (milestone) return `${milestone.id}: ${milestone.title}`;
	if (mission.status === "complete") return "Mission complete";
	if (mission.status === "planned" || mission.status === "planning") return "Ready to start";
	return "No current task";
}

function deriveLocationLabels(cwd: string): Pick<MissionControlMissionView, "cwdLabel" | "repoLabel" | "worktreeLabel" | "locationLabel"> {
	const normalized = path.resolve(cwd);
	const cwdLabel = normalized;
	const repoLabel = path.basename(normalized) || normalized;
	const parent = path.basename(path.dirname(normalized));
	const worktreeLabel = parent && parent !== path.basename(normalized) ? `${parent}/${path.basename(normalized)}` : undefined;
	return { cwdLabel, repoLabel, worktreeLabel, locationLabel: worktreeLabel ?? repoLabel };
}

function compareMissionViews(a: MissionControlMissionView, b: MissionControlMissionView): number {
	return (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
