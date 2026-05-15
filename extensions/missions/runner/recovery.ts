import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent, BASE_SKILLS, missionDir, nowIso, writeJson } from "../runtime-core.js";
import { ORCHESTRATOR_STATE_ENTRY, type BlockReasonCategory, type MissionBlockMetadata, type MissionBlockSummary, type MissionOrchestratorSessionState, type MissionRuntimeOrchestratorRecoveryPacket, type MissionState } from "../runtime-types.js";
import { orchestratorSessionRecordFile, readOrchestratorSessionRecord, writeOrchestratorSessionRecord } from "../core/session-records.js";

export type BuildOrchestratorState = (cwd: string, mission?: MissionState, overrides?: Partial<MissionOrchestratorSessionState>) => MissionOrchestratorSessionState;

function existingPaths(paths: string[]): string[] {
	return paths.filter((file) => fs.existsSync(file));
}

export function describeBlock(block: MissionBlockMetadata): string {
	return `${block.reasonCategory} on ${block.kind} ${block.failedItemId} (${block.failedItemTitle}); run ${block.runId}${block.status ? ` reported ${block.status}` : ""}`;
}

function blockMetadataFromSummary(block: MissionBlockSummary, reasonCategory: BlockReasonCategory): MissionBlockMetadata {
	return {
		schemaVersion: 1,
		timestamp: nowIso(),
		reasonCategory,
		kind: block.kind,
		failedItemId: block.kind === "worker" ? block.featureId ?? block.milestoneId : block.featureId ?? block.milestoneId,
		failedItemTitle: block.kind === "worker" ? block.featureTitle ?? block.milestoneTitle : block.featureTitle ?? block.milestoneTitle,
		missionId: block.missionId,
		milestoneId: block.milestoneId,
		featureId: block.featureId,
		runId: block.runId,
		runDir: block.runDir,
		exitCode: block.exitCode,
		status: block.status,
		dirty: block.dirty,
		artifactPaths: block.artifactPaths,
	};
}

function writeRecoveryPacket(dir: string, mission: MissionState, block: MissionBlockMetadata): string[] {
	const packetDir = path.join(dir, "recovery-packets");
	const base = `${block.timestamp.replace(/[:.]/g, "-")}-${block.runId}`;
	const jsonFile = path.join(packetDir, `${base}.json`);
	const mdFile = path.join(packetDir, `${base}.md`);
	const packet: MissionRuntimeOrchestratorRecoveryPacket = {
		schemaVersion: 1,
		missionId: mission.id,
		missionTitle: mission.title,
		status: "orchestrator_action_required",
		createdAt: nowIso(),
		block,
		dispatch: {
			target: "dedicated-runtime-orchestrator-session",
			trigger: "runner-after-block",
			runnerWritesPacket: true,
			fallback: "main-chat-display-only",
			orchestratorSessionRecordPath: orchestratorSessionRecordFile(mission.cwd, mission.id),
		},
		authority: {
			runner: [
				"Writes block metadata and this recovery packet after the blocking child/unit has finished.",
				"Stops deterministic execution until mission metadata/control state is safe and runnable.",
			],
			runtimeOrchestrator: {
				mayUseMissionTools: true,
				mayReviseMissionMetadata: true,
				mayEditRepositoryImplementation: false,
				repositoryEditPolicy: "forbidden-by-default",
			},
			mainChat: [
				"Human command, question, and override channel.",
				"Receives display-only recovery context when dedicated session dispatch is unavailable.",
			],
			missionControl: "read-only-observability",
		},
		allowedOutcomes: [
			{ outcome: "resume", description: "Resume the deterministic runner without changing implementation code.", safeWhen: "Mission metadata is consistent and pending work is runnable." },
			{ outcome: "ask-user", description: "Ask the user in main chat for product, policy, or external input.", safeWhen: "The safe recovery path depends on human judgment or unavailable external information.", requiresHuman: true },
			{ outcome: "leave-blocked", description: "Leave the mission blocked with an explicit reason.", safeWhen: "No safe metadata/control-state repair is available yet." },
			{ outcome: "retry-repair", description: "Revise mission metadata/control state or retry/repair through mission APIs/tools.", safeWhen: "Artifacts show a procedural, planning, stale-state, or retryable issue that can be corrected without direct repository implementation edits." },
			{ outcome: "rerun-validation", description: "Rerun milestone validation when safe after metadata/control-state repair.", safeWhen: "Validation artifacts were missing, inconclusive because of environment/procedure, or stale relative to accepted completed work." },
		],
		instructions: [
			"Inspect block artifacts and transcript/stderr.",
			"Classify the failure as implementation defect, validator defect, procedural failure, environment issue, or planning issue.",
			"Use mission tools/APIs to revise mission metadata or runner control state when safe.",
			"Do not edit repository implementation code by default; add implementation work only by revising mission metadata/plan for worker execution.",
			"Do not advance later features while this recovery packet is unresolved.",
		],
	};
	writeJson(jsonFile, packet);
	fs.writeFileSync(mdFile, [
		"# Mission Recovery Packet",
		"",
		`- Mission: ${mission.id} - ${mission.title}`,
		`- Status: orchestrator_action_required`,
		`- Dispatch target: ${packet.dispatch.target}`,
		`- Fallback: ${packet.dispatch.fallback}`,
		`- Block: ${describeBlock(block)}`,
		`- Run directory: ${block.runDir}`,
		"",
		"## Authority contract",
		"- Runner writes block metadata/recovery context, then stops deterministic execution until state is runnable.",
		"- Runtime orchestrator may use mission tools/APIs to revise mission metadata or runner control state.",
		"- Runtime orchestrator must not edit repository implementation code by default; implementation repairs must be planned for worker execution.",
		"- Main chat is the human command, question, and override channel.",
		"- Mission Control remains read-only observability.",
		"",
		"## Allowed recovery outcomes",
		...packet.allowedOutcomes.map((option) => `- ${option.outcome}: ${option.description} Safe when: ${option.safeWhen}`),
		"",
		"## Required orchestrator action",
		"1. Inspect block artifacts and transcript/stderr.",
		"2. Classify the failure.",
		"3. Use mission tools/APIs to repair metadata/control state when safe, revise the mission plan for worker repair work, resume, ask the user, rerun validation when safe, or leave blocked with a clear reason.",
		"4. Do not edit repository implementation code by default.",
		"5. Do not advance later features while this packet is unresolved.",
		"",
		"## Artifacts",
		...block.artifactPaths.map((artifact) => `- ${artifact}`),
		"",
	].join("\n"));
	return [jsonFile, mdFile];
}

export function persistMissionBlock(dir: string, mission: MissionState, block: MissionBlockSummary, reasonCategory: BlockReasonCategory): void {
	block.reasonCategory = reasonCategory;
	const latestBlock = blockMetadataFromSummary(block, reasonCategory);
	if (mission.status === "blocked" || mission.status === "failed") {
		const packetPaths = writeRecoveryPacket(dir, mission, latestBlock);
		latestBlock.artifactPaths = existingPaths([...latestBlock.artifactPaths, ...packetPaths]);
		appendEvent(dir, "orchestrator_recovery_packet_created", { missionId: mission.id, featureId: latestBlock.featureId, runId: latestBlock.runId, packetPaths });
	}
	mission.latestBlock = latestBlock;
	appendEvent(dir, "mission_block_recorded", latestBlock);
}

export function formatMissionBlockMessage(block: MissionBlockSummary, routedToRuntimeOrchestrator: boolean): string {
	const failedItem = block.kind === "worker"
		? `Feature ${block.featureId} - ${block.featureTitle}`
		: `Milestone ${block.milestoneId} - ${block.milestoneTitle}`;
	return [
		"[MISSION BLOCKED - RECOVERY CONTEXT]",
		block.reasonCategory === "no_runnable_pending_work"
			? "Mission execution stopped because pending work remains but no feature is currently runnable."
			: "A mission child agent blocked execution.",
		routedToRuntimeOrchestrator
			? "Default recovery has been routed to the mission's dedicated runtime orchestrator session. This main chat copy is display-only visibility for human override."
			: "Dedicated runtime orchestrator session dispatch is unavailable here. This main chat copy is the display-only fallback for human override and manual recovery.",
		"",
		`Mission: ${block.missionId} — ${block.missionTitle}`,
		`Blocked during: ${block.kind}`,
		`Failed item: ${failedItem}`,
		block.kind === "worker" ? `Milestone: ${block.milestoneId} - ${block.milestoneTitle}` : undefined,
		`Run id: ${block.runId}`,
		`Run directory: ${block.runDir}`,
		block.reasonCategory ? `Reason category: ${block.reasonCategory}` : undefined,
		`Exit code: ${block.exitCode}`,
		block.status ? `Reported status: ${block.status}` : undefined,
		block.dirty ? `Git status after child run:\n${block.dirty}` : undefined,
		"",
		"Artifacts:",
		...(block.artifactPaths.length > 0 ? block.artifactPaths.map((file) => `- ${file}`) : ["- No handoff/report artifact found; inspect transcript/stderr in the run directory."]),
		"",
		"Suggested next inspection steps:",
		block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : block.validatorMode === "user-testing" ? "1. Read user-testing-report.json and user-testing-report.md if present." : "1. Read validation-report.json and validation-report.md if present.",
		"2. Inspect transcript.jsonl and stderr.txt in the run directory for the child-agent failure mode.",
		"3. Check `git status --short` and review any relevant diffs/commits mentioned by the artifacts.",
		"4. Decide whether this is an implementation defect, validation defect, planning issue, environmental/tooling issue, or procedural failure; revise/resume the mission only after the recovery path is clear.",
	].filter((line): line is string => Boolean(line)).join("\n");
}

function runtimeOrchestratorSkillInjectionContent(): string {
	let orchestratorSkill = "";
	try {
		orchestratorSkill = fs.readFileSync(BASE_SKILLS.orchestrator, "utf8");
	} catch (error) {
		orchestratorSkill = `Mission orchestrator skill could not be loaded from ${BASE_SKILLS.orchestrator}: ${String(error)}`;
	}
	return [
		"[MISSION RUNTIME ORCHESTRATOR SKILL INJECTION]",
		"Use the mission-orchestrator skill for this runtime recovery turn. This hidden context gives the dedicated runtime orchestrator the same role-specific skill injection model used for worker and validator child roles.",
		`Skill file: ${BASE_SKILLS.orchestrator}`,
		"",
		orchestratorSkill,
	].join("\n");
}

async function injectRuntimeOrchestratorSkill(nextCtx: { sendMessage: ExtensionAPI["sendMessage"] }): Promise<void> {
	await nextCtx.sendMessage({
		customType: "missions-runtime-orchestrator-skill-injection",
		display: false,
		content: runtimeOrchestratorSkillInjectionContent(),
		details: { skill: "mission-orchestrator", skillPath: BASE_SKILLS.orchestrator },
	}, { triggerTurn: false, deliverAs: "followUp" });
}

function runtimeOrchestratorRecoveryPrompt(mission: MissionState, block: MissionBlockSummary): string {
	const packetArtifacts = block.artifactPaths.filter((artifact) => artifact.includes(`${path.sep}recovery-packets${path.sep}`));
	return [
		"[MISSION RUNTIME ORCHESTRATOR RECOVERY]",
		"The deterministic mission runner has stopped after a recoverable block. You are the dedicated runtime orchestrator session for this mission.",
		"The mission-orchestrator skill has been injected into this recovery session as hidden context. Follow it for recovery procedure and authority boundaries.",
		"Do not edit repository implementation code by default. Use mission tools/APIs to inspect artifacts, revise mission metadata/control state, retry/repair state, resume, ask the user, rerun validation when safe, or leave the mission blocked with a clear reason.",
		"Main chat remains the human command/question/override channel. Mission Control remains read-only observability.",
		"",
		`Mission: ${mission.id} — ${mission.title} [${mission.status}]`,
		`Mission directory: ${missionDir(mission.cwd, mission.id)}`,
		`Target repository cwd: ${mission.cwd}`,
		`Current milestone: ${mission.currentMilestoneId ?? "not set"}`,
		`Current feature: ${mission.currentFeatureId ?? "not set"}`,
		"",
		"## Block",
		formatMissionBlockMessage(block, true),
		"",
		"## Recovery packet",
		...(packetArtifacts.length > 0 ? packetArtifacts.map((artifact) => `- ${artifact}`) : ["- Recovery packet path was not present in block artifact paths; inspect the mission's recovery-packets directory."]),
		"",
		"## Required recovery behavior",
		"1. Inspect the recovery packet and failed run artifacts.",
		"2. Classify the failure as implementation defect, validator defect, procedural failure, environment/tooling issue, stale-state issue, dependency/planning issue, or retry-limit exceeded.",
		"3. Use mission tools/APIs for mission metadata/control-state recovery. Do not directly implement repository code unless the user explicitly overrides the mission contract.",
		"4. Choose one allowed outcome: resume, ask-user, leave-blocked, retry-repair, or rerun-validation when safe.",
		"5. Do not advance later features while this block is unresolved.",
	].join("\n");
}

function hasSessionSwitchControls(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as ExtensionCommandContext).newSession === "function" && typeof (ctx as ExtensionCommandContext).switchSession === "function";
}

export async function dispatchMissionBlockRecovery(ctx: ExtensionContext, pi: ExtensionAPI, mission: MissionState, block: MissionBlockSummary, buildOrchestratorState: BuildOrchestratorState): Promise<void> {
	const dir = missionDir(mission.cwd, mission.id);
	const controlsAvailable = hasSessionSwitchControls(ctx);
	pi.sendMessage({
		customType: "missions-block-context",
		display: true,
		content: formatMissionBlockMessage(block, controlsAvailable),
		details: { ...block, recoveryDispatchTarget: controlsAvailable ? "dedicated-runtime-orchestrator-session" : "main-chat-display-only" },
	}, { triggerTurn: false, deliverAs: "followUp" });
	if (!controlsAvailable) {
		appendEvent(dir, "runtime_orchestrator_recovery_dispatch_unavailable", { missionId: mission.id, runId: block.runId, reasonCategory: block.reasonCategory, fallback: "main-chat-display-only" });
		return;
	}

	const content = runtimeOrchestratorRecoveryPrompt(mission, block);
	const details = { missionId: mission.id, missionDir: dir, runId: block.runId, runDir: block.runDir, reasonCategory: block.reasonCategory, target: "dedicated-runtime-orchestrator-session" };
	const existing = readOrchestratorSessionRecord(mission.cwd, mission.id);
	const existingSessionPath = existing?.sessionPath && fs.existsSync(existing.sessionPath) ? existing.sessionPath : undefined;
	const parentSession = ctx.sessionManager.getSessionFile();
	appendEvent(dir, "runtime_orchestrator_recovery_dispatch_requested", { ...details, sessionPath: existingSessionPath, reusedSession: Boolean(existingSessionPath) });
	try {
		if (existingSessionPath) {
			await ctx.switchSession(existingSessionPath, {
				withSession: async (nextCtx) => {
					await injectRuntimeOrchestratorSkill(nextCtx);
					await nextCtx.sendMessage({ customType: "missions-runtime-orchestrator-recovery", display: true, content, details: { ...details, reusedSession: true, sessionPath: existingSessionPath } }, { triggerTurn: true, deliverAs: "followUp" });
					appendEvent(dir, "runtime_orchestrator_recovery_dispatched", { ...details, sessionPath: existingSessionPath, reusedSession: true, triggerTurn: true, injectedSkill: "mission-orchestrator", skillPath: BASE_SKILLS.orchestrator });
				},
			});
			return;
		}

		let createdSessionPath = "";
		await ctx.newSession({
			parentSession,
			setup: async (sessionManager) => {
				createdSessionPath = sessionManager.getSessionFile() || "";
				sessionManager.appendSessionInfo(`Mission runtime orchestrator: ${mission.title}`);
				sessionManager.appendCustomEntry(ORCHESTRATOR_STATE_ENTRY, buildOrchestratorState(mission.cwd, mission, { activeMissionId: mission.id, activePlanningMissionId: undefined, activeRunningMissionId: mission.id }));
				writeOrchestratorSessionRecord(mission.cwd, mission.id, {
					sessionId: createdSessionPath ? path.basename(createdSessionPath, path.extname(createdSessionPath)) : `pid-${process.pid}`,
					sessionPath: createdSessionPath,
					createdAt: nowIso(),
					active: true,
				});
			},
			withSession: async (nextCtx) => {
				await injectRuntimeOrchestratorSkill(nextCtx);
				await nextCtx.sendMessage({ customType: "missions-runtime-orchestrator-recovery", display: true, content, details: { ...details, reusedSession: false, sessionPath: createdSessionPath } }, { triggerTurn: true, deliverAs: "followUp" });
				appendEvent(dir, "runtime_orchestrator_recovery_dispatched", { ...details, sessionPath: createdSessionPath, reusedSession: false, triggerTurn: true, injectedSkill: "mission-orchestrator", skillPath: BASE_SKILLS.orchestrator });
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendEvent(dir, "runtime_orchestrator_recovery_dispatch_failed", { ...details, error: message, fallback: "main-chat-display-only" });
	}
}
