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

export function loadMissionControlViewModel(cwd: string, options: { root?: string; includeClearedCompleted?: boolean } = {}): MissionControlViewModel {
	const root = options.root ?? missionRoot(cwd);
	const cleared = options.includeClearedCompleted ? new Set<string>() : loadClearedMissionIds(cwd, root);
	const missions = fs.existsSync(root)
		? fs.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(root, entry.name, "mission.json"))
			.filter((file) => fs.existsSync(file))
			.flatMap((file) => {
				try { return [readJson<MissionState>(file)]; } catch { return []; }
			})
			.filter((mission) => mission.status !== "complete" || !cleared.has(mission.id))
		: [];
	return createMissionControlViewModel(missions);
}

export function createMissionControlViewModel(missions: MissionState[]): MissionControlViewModel {
	const missionViews = missions.map(createMissionControlMissionView);
	const sections = MISSION_CONTROL_SECTION_ORDER.map((section) => ({
		id: section.id,
		title: section.title,
		missions: missionViews
			.filter((mission) => section.statuses.includes(mission.status))
			.sort(compareMissionViews),
	}));
	return { sections, missions: sections.flatMap((section) => section.missions) };
}

export function createMissionControlMissionView(mission: MissionState): MissionControlMissionView {
	const allFeatures = flattenFeatures(mission);
	const progress = {
		completed: allFeatures.filter((feature) => feature.status === "complete" || feature.status === "skipped").length,
		total: allFeatures.length,
	};
	const labels = deriveLocationLabels(mission.cwd);
	return {
		id: mission.id,
		title: mission.title,
		status: mission.status,
		cwd: mission.cwd,
		...labels,
		currentTask: deriveCurrentTask(mission, allFeatures),
		progress,
		activeRun: mission.activeRun,
		currentMilestoneId: mission.currentMilestoneId,
		currentFeatureId: mission.currentFeatureId,
		currentBlock: mission.status === "blocked" || mission.status === "failed" ? mission.latestBlock : undefined,
		updatedAt: mission.updatedAt,
	};
}

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
