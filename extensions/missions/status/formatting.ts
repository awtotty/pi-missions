import { missionDir } from "../runtime-core.js";
import type { MissionBlockMetadata, MissionMilestone, MissionRunContext, MissionRunLifecycleClassification, MissionState } from "../runtime-types.js";
import type { MissionControlMissionView, MissionControlViewModel } from "../core/mission-control-view-model.js";

export function mark(status: string): string {
	if (status === "complete") return "✓";
	if (status === "running") return "⏳";
	if (status === "failed" || status === "blocked") return "✗";
	if (status === "skipped") return "↷";
	return "○";
}

export function nextSuggestedAction(mission: MissionState, lifecycle: MissionRunLifecycleClassification, run?: MissionRunContext, block?: MissionBlockMetadata): string {
	if (mission.status === "planning") return "Continue planning, then persist the plan when it is ready.";
	if (mission.status === "planned") return `Run /missions run ${mission.id} to start execution.`;
	if (lifecycle.state === "interrupted") {
		const runHint = run ? `Inspect ${run.runDir} for transcript/stderr evidence from ${run.runId}.` : `Inspect ${missionDir(mission.cwd, mission.id)} run artifacts.`;
		return `${runHint} Then use /missions run ${mission.id} to attempt safe recovery/resume. Mission Control is read-only.`;
	}
	if (mission.status === "running") return run ? `Monitor ${run.runDir} or wait for run ${run.runId} to finish.` : "Mission is running; wait for the next worker or validator update.";
	if (mission.status === "paused") return `Run /missions resume ${mission.id} when ready.`;
	if (mission.status === "blocked") return block ? `Inspect the recovery packet and block artifacts for ${block.runId}, decide the recovery path, then revise or resume the mission.` : `Inspect ${missionDir(mission.cwd, mission.id)} and decide whether to revise or resume the mission.`;
	if (mission.status === "failed") return block ? `Inspect failure artifacts in ${block.runDir} before retrying or revising.` : `Inspect ${missionDir(mission.cwd, mission.id)} before retrying or revising.`;
	return `Mission is complete. Use /missions clear to hide completed missions from default Mission Control UI.`;
}

export function missionFooterProgressBar(completed: number, total: number, width = 4): string {
	if (total <= 0) return "▱".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((completed / total) * width)));
	return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

export function missionFooterStatusText(mission: MissionControlMissionView): string {
	if (mission.status === "blocked" && mission.currentBlock) return `${mission.status} · ${mission.currentBlock.reasonCategory}`;
	if (mission.status === "failed" && mission.currentBlock) return `${mission.status} · ${mission.currentBlock.reasonCategory}`;
	return mission.status;
}

export function chooseFooterMission(vm: MissionControlViewModel, preferredMissionId?: string): MissionControlMissionView | undefined {
	if (preferredMissionId) {
		const preferred = vm.missions.find((entry) => entry.id === preferredMissionId && entry.status !== "complete");
		if (preferred) return preferred;
	}
	return vm.sections.find((section) => section.id !== "completed" && section.missions.length > 0)?.missions[0];
}

export function formatMissionStatusSummary(input: {
	mission: MissionState;
	featureCount: number;
	completedFeatureCount: number;
	milestones: MissionMilestone[];
	run?: MissionRunContext;
	lifecycle: MissionRunLifecycleClassification;
	lifecycleEvaluation: string;
	block?: MissionBlockMetadata;
	describeBlock: (block: MissionBlockMetadata) => string;
}): string {
	const { mission, featureCount, completedFeatureCount, milestones, run, lifecycle, lifecycleEvaluation, block } = input;
	return [
		`Mission: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Progress: ${completedFeatureCount}/${featureCount} features`,
		`Dir: ${missionDir(mission.cwd, mission.id)}`,
		`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`,
		`Lifecycle evaluation: ${lifecycleEvaluation}`,
		run ? `${run.label}: ${run.runId}` : "Current/last run: none recorded",
		run ? `Run item: ${run.kind} ${run.itemId} — ${run.itemTitle}` : undefined,
		run ? `Run artifacts: ${run.runDir}` : undefined,
		block ? `Blocked reason: ${input.describeBlock(block)}` : undefined,
		block?.artifactPaths.length ? `Block artifacts: ${block.artifactPaths.join(", ")}` : undefined,
		`Next suggested action: ${nextSuggestedAction(mission, lifecycle, run, block)}`,
		"",
		...milestones.flatMap((m) => [
			`${mark(m.status)} ${m.id}: ${m.title}${m.validationRunId ? ` [validator ${m.validationRunId}]` : ""}`,
			...m.features.map((f) => `  ${mark(f.status)} ${f.id}: ${f.title}${f.runId ? ` [run ${f.runId}]` : ""}${f.userTestingPending ? " [awaiting user-testing]" : ""}${f.commit ? ` (${f.commit})` : ""}`),
		]),
	].filter((line): line is string => line !== undefined).join("\n");
}

export function missionListTextFromMissions(missions: MissionState[], isCleared: (missionId: string) => boolean): string {
	return missions.length ? missions.map((m) => `${m.id}  ${m.status}${isCleared(m.id) ? " (cleared)" : ""}  ${m.title}`).join("\n") : "No missions found.";
}
