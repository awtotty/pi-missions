import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	appendEvent,
	BASE_SKILLS,
	clearedMissionsFile,
	ensureDir,
	globalSettingsFile,
	isMissionRole,
	missionDir,
	missionRoot,
	nowIso,
	parentSessionMarker,
	readJson,
	writeJson,
} from "./runtime-core.js";
import {
	DEFAULT_MILESTONE_VALIDATION_FAILURE_LIMIT,
	LEGACY_ACTIVE_PLANNING_ENTRY,
	MISSION_ROLES,
	ORCHESTRATOR_STATE_ENTRY,
	PLANNING_KICKOFF_ENTRY,
	type BlockReasonCategory,
	type ClearCompletedResult,
	type ClearedMissionsState,
	type ItemStatus,
	type MissionActiveRunOwnership,
	type MissionBlockMetadata,
	type MissionBlockSummary,
	type MissionChildSessionRecord,
	type MissionChildSessionRegistry,
	type MissionCommandResult,
	type MissionFeature,
	type MissionMilestone,
	type MissionOrchestratorSessionRecord,
	type MissionOrchestratorSessionState,
	type MissionRole,
	type MissionRoleModels,
	type MissionRunContext,
	type MissionRunKind,
	type MissionRunLifecycleClassification,
	type MissionRunLifecycleState,
	type MissionRunnerLockArtifact,
	type MissionState,
	type RunResult,
	type RunnerCommandInput,
	type RunnerCommandName,
	type Status,
	type ValidationContractAssertion,
} from "./runtime-types.js";
import { formatGlobalModels, normalizeRoleModels, readMissionGlobalSettings, setGlobalModel } from "./core/settings.js";
import { computeRecoveryGatePlan } from "./recovery-gate.js";
import { loadMissionControlViewModel, type MissionControlMissionView, type MissionControlOutputView, type MissionControlSectionView, type MissionControlViewModel } from "./core/mission-control-view-model.js";
import { artifactValidationErrorSummary, validateMissionArtifact } from "./runtime-artifact-schemas.js";

function orchestratorSessionRecordFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "orchestrator-session.json");
}

function childSessionRegistryFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "child-sessions.json");
}

function readChildSessionRegistry(cwd: string, missionId: string): MissionChildSessionRegistry {
	const file = childSessionRegistryFile(cwd, missionId);
	if (!fs.existsSync(file)) return { schemaVersion: 1, updatedAt: nowIso(), records: [] };
	try {
		const parsed = readJson<MissionChildSessionRegistry>(file);
		if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.records)) return { schemaVersion: 1, updatedAt: nowIso(), records: [] };
		return { schemaVersion: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(), records: parsed.records.filter((item) => item && typeof item === "object") };
	} catch {
		return { schemaVersion: 1, updatedAt: nowIso(), records: [] };
	}
}

function writeChildSessionRegistry(cwd: string, missionId: string, records: MissionChildSessionRecord[]): void {
	writeJson(childSessionRegistryFile(cwd, missionId), { schemaVersion: 1, updatedAt: nowIso(), records });
}

function parseRunOwnershipSessionId(runDir: string): string | undefined {
	const file = path.join(runDir, "run-ownership.json");
	if (!fs.existsSync(file)) return undefined;
	try {
		const ownership = readJson<{ parentSessionMarker?: unknown }>(file);
		if (typeof ownership.parentSessionMarker === "string" && ownership.parentSessionMarker.trim()) return ownership.parentSessionMarker;
	} catch {
		return undefined;
	}
	return undefined;
}

function parseTranscriptSessionIdentity(transcriptFile: string): { sessionId?: string; sessionPath?: string } {
	if (!fs.existsSync(transcriptFile)) return {};
	try {
		const content = fs.readFileSync(transcriptFile, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; sessionPath?: unknown; path?: unknown };
			if (parsed.type !== "session") continue;
			const sessionId = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : undefined;
			const sessionPath = typeof parsed.sessionPath === "string" && parsed.sessionPath.trim()
				? parsed.sessionPath
				: (typeof parsed.path === "string" && parsed.path.trim() ? parsed.path : undefined);
			return { sessionId, sessionPath };
		}
	} catch {
		return {};
	}
	return {};
}

function nextChildAttemptNumber(cwd: string, missionId: string, role: "worker" | "validator" | "user-testing-validator" | "reviewer", featureId: string | undefined): number {
	const registry = readChildSessionRegistry(cwd, missionId);
	return registry.records.filter((record) => record.role === role && record.featureId === featureId).length + 1;
}

function upsertChildSessionRecord(cwd: string, missionId: string, record: MissionChildSessionRecord): void {
	const registry = readChildSessionRegistry(cwd, missionId);
	const next = registry.records.filter((item) => item.runId !== record.runId);
	next.push(record);
	writeChildSessionRegistry(cwd, missionId, next.sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
}

function childSessionRecordForRun(run: MissionRunContext): MissionChildSessionRecord | undefined {
	const missionPath = path.dirname(path.dirname(run.runDir));
	const file = path.join(missionPath, "child-sessions.json");
	if (!fs.existsSync(file)) return undefined;
	try {
		const parsed = readJson<MissionChildSessionRegistry>(file);
		if (!Array.isArray(parsed?.records)) return undefined;
		return parsed.records.find((item) => item.runId === run.runId);
	} catch {
		return undefined;
	}
}

function readOrchestratorSessionRecord(cwd: string, missionId: string): MissionOrchestratorSessionRecord | undefined {
	const file = orchestratorSessionRecordFile(cwd, missionId);
	if (!fs.existsSync(file)) return undefined;
	try {
		const record = readJson<MissionOrchestratorSessionRecord>(file);
		if (record?.schemaVersion !== 1 || record.missionId !== missionId || typeof record.sessionPath !== "string" || !record.sessionPath.trim()) return undefined;
		return record;
	} catch {
		return undefined;
	}
}

function writeOrchestratorSessionRecord(cwd: string, missionId: string, value: Omit<MissionOrchestratorSessionRecord, "schemaVersion" | "missionId">): MissionOrchestratorSessionRecord {
	const record: MissionOrchestratorSessionRecord = { schemaVersion: 1, missionId, ...value };
	writeJson(orchestratorSessionRecordFile(cwd, missionId), record);
	return record;
}

function sessionIdentity(ctx: ExtensionContext): { sessionId: string; sessionPath: string } | undefined {
	const sessionPath = ctx.sessionManager.getSessionFile() || "";
	if (!sessionPath.trim()) return undefined;
	return {
		sessionId: path.basename(sessionPath, path.extname(sessionPath)) || `pid-${process.pid}`,
		sessionPath,
	};
}

function ensureOfficialOrchestratorSessionRecord(ctx: ExtensionContext, mission: MissionState): MissionOrchestratorSessionRecord | undefined {
	const identity = sessionIdentity(ctx);
	if (!identity) return undefined;
	const existing = readOrchestratorSessionRecord(ctx.cwd, mission.id);
	const shouldReuseExisting = existing?.active && fs.existsSync(existing.sessionPath);
	if (shouldReuseExisting) return existing;
	return writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
		sessionId: identity.sessionId,
		sessionPath: identity.sessionPath,
		createdAt: existing?.createdAt || nowIso(),
		active: isActiveMissionStatus(mission.status),
	});
}

function setActiveRunOwnership(mission: MissionState, run: { kind: MissionRunKind; itemId: string; runId: string; startedAt?: string }): MissionActiveRunOwnership {
	const ownership: MissionActiveRunOwnership = {
		schemaVersion: 1,
		kind: run.kind,
		itemId: run.itemId,
		runId: run.runId,
		parentPid: process.pid,
		parentSessionMarker: parentSessionMarker(),
		startedAt: run.startedAt ?? nowIso(),
		intent: "active",
	};
	mission.activeRun = ownership;
	return ownership;
}

function clearActiveRunOwnership(mission: MissionState): void {
	mission.activeRun = undefined;
}

function persistRunOwnershipArtifact(runDir: string, ownership: MissionActiveRunOwnership): void {
	writeJson(path.join(runDir, "run-ownership.json"), ownership);
}

function pauseRequestFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "pause-request.json");
}

function readMissionPauseRequest(cwd: string, missionId: string): { requestedAt: string; source?: string } | undefined {
	const file = pauseRequestFile(cwd, missionId);
	if (!fs.existsSync(file)) return undefined;
	try {
		const request = readJson<{ requestedAt?: unknown; source?: unknown }>(file);
		if (typeof request.requestedAt === "string" && request.requestedAt.trim()) return { requestedAt: request.requestedAt, source: typeof request.source === "string" ? request.source : undefined };
	} catch {
		// Treat malformed pause markers as present so Mission Control does not accidentally resume past a user's stop request.
	}
	return { requestedAt: nowIso(), source: "malformed_pause_request" };
}

function hasMissionPauseRequest(cwd: string, missionId: string): boolean {
	return Boolean(readMissionPauseRequest(cwd, missionId));
}

function clearMissionPauseRequest(cwd: string, missionId: string): void {
	const file = pauseRequestFile(cwd, missionId);
	if (fs.existsSync(file)) fs.unlinkSync(file);
}

function requestMissionPauseAfterCurrent(cwd: string, mission: MissionState, source: string): MissionCommandResult {
	const dir = missionDir(cwd, mission.id);
	const requestedAt = nowIso();
	writeJson(pauseRequestFile(cwd, mission.id), { schemaVersion: 1, missionId: mission.id, requestedAt, source });
	const latest = loadMission(cwd, mission.id);
	if (latest.status === "paused") {
		latest.pauseRequestedAt = requestedAt;
		saveMission(cwd, latest);
	}
	appendEvent(dir, "mission_pause_requested", { missionId: mission.id, requestedAt, source });
	return { ok: true, text: `Pause-after-current requested for ${mission.id}. Current worker/validator will continue; no new unit will start.` };
}

function applyPauseAfterCurrentIfRequested(ctx: ExtensionContext, missionId: string, completedUnit: string): boolean {
	const request = readMissionPauseRequest(ctx.cwd, missionId);
	if (!request) return false;
	const mission = loadMission(ctx.cwd, missionId);
	if (mission.status === "complete" || mission.status === "failed" || mission.status === "blocked") return false;
	transitionMissionPauseAfterCurrent(mission, request.requestedAt);
	saveMission(mission.cwd, mission);
	appendEvent(missionDir(ctx.cwd, missionId), "mission_paused_after_current", { missionId, requestedAt: request.requestedAt, completedUnit });
	updateWidget(ctx, mission);
	clearMissionRunStatus(ctx);
	ctx.ui.notify(`Mission paused after current unit: ${mission.title}`, "info");
	return true;
}

const EXECUTION_STARTED_EVENT_TYPES = new Set(["mission_execution_started", "worker_started", "validator_started", "mission_block_recorded", "mission_complete"]);
const ACTIVE_MISSION_RUNS = new Set<string>();
const ACTIVE_MISSION_CHILD_ABORTERS = new Map<string, AbortController>();
const RUNNER_HEARTBEAT_INTERVAL_MS = 5_000;
const RUNNER_HEARTBEAT_TIMEOUT_MS = 20_000;
const RUNNER_LOCK_GUARD_TIMEOUT_MS = 30_000;
const RUNNER_LOCK_GUARD_WAIT_MS = 2_000;
const RUNNER_LOCK_GUARD_RETRY_DELAY_MS = 50;

function activeMissionRunKey(cwd: string, missionId: string): string {
	return `${cwd}\u0000${missionId}`;
}

function isMissionRunActive(cwd: string, missionId: string): boolean {
	return ACTIVE_MISSION_RUNS.has(activeMissionRunKey(cwd, missionId));
}

function activeMissionChildAbortController(cwd: string, missionId: string): AbortController | undefined {
	return ACTIVE_MISSION_CHILD_ABORTERS.get(activeMissionRunKey(cwd, missionId));
}

function tryCancelCurrentChild(cwd: string, missionId: string): boolean {
	const controller = activeMissionChildAbortController(cwd, missionId);
	if (!controller || controller.signal.aborted) return false;
	controller.abort();
	return true;
}

function runnerLockFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "runner-lock.json");
}

function runnerLockGuardDir(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "runner-lock.guard");
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRunnerLockGuard<T>(cwd: string, missionId: string, work: () => T | Promise<T>): Promise<T> {
	const guardDir = runnerLockGuardDir(cwd, missionId);
	const deadline = Date.now() + RUNNER_LOCK_GUARD_WAIT_MS;
	while (true) {
		try {
			fs.mkdirSync(guardDir);
			writeJson(path.join(guardDir, "claim.json"), {
				schemaVersion: 1,
				missionId,
				ownerPid: process.pid,
				ownerSessionMarker: parentSessionMarker(),
				acquiredAt: nowIso(),
			});
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const claimFile = path.join(guardDir, "claim.json");
			let stale = false;
			try {
				const claim = readJson<{ acquiredAt?: unknown; ownerPid?: unknown }>(claimFile);
				const acquiredAt = typeof claim.acquiredAt === "string" ? Date.parse(claim.acquiredAt) : Number.NaN;
				const ownerPid = typeof claim.ownerPid === "number" ? claim.ownerPid : undefined;
				const guardExpired = !Number.isFinite(acquiredAt) || Date.now() - acquiredAt > RUNNER_LOCK_GUARD_TIMEOUT_MS;
				const ownerAlive = ownerPid === undefined ? undefined : isPidAlive(ownerPid);
				stale = guardExpired && ownerAlive === false;
			} catch {
				stale = true;
			}
			if (stale) {
				try {
					fs.rmSync(guardDir, { recursive: true, force: true });
					continue;
				} catch {
					// Another process may be recovering simultaneously; retry below.
				}
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for runner lock guard for mission ${missionId}.`);
			await sleepMs(RUNNER_LOCK_GUARD_RETRY_DELAY_MS);
		}
	}
	try {
		return await work();
	} finally {
		try {
			fs.rmSync(guardDir, { recursive: true, force: true });
		} catch {
			// Best-effort guard cleanup.
		}
	}
}

function readRunnerLock(cwd: string, missionId: string): MissionRunnerLockArtifact | undefined {
	const file = runnerLockFile(cwd, missionId);
	if (!fs.existsSync(file)) return undefined;
	try {
		const parsed = readJson<Partial<MissionRunnerLockArtifact>>(file);
		if (parsed?.schemaVersion !== 1 || typeof parsed.missionId !== "string" || parsed.missionId !== missionId) return undefined;
		if (typeof parsed.ownerPid !== "number" || typeof parsed.ownerSessionMarker !== "string" || typeof parsed.acquiredAt !== "string" || typeof parsed.heartbeatAt !== "string") return undefined;
		const status = parsed.status === "released" ? "released" : "active";
		return {
			schemaVersion: 1,
			missionId,
			ownerPid: parsed.ownerPid,
			ownerSessionMarker: parsed.ownerSessionMarker,
			acquiredAt: parsed.acquiredAt,
			heartbeatAt: parsed.heartbeatAt,
			heartbeatTimeoutMs: typeof parsed.heartbeatTimeoutMs === "number" && parsed.heartbeatTimeoutMs > 0 ? parsed.heartbeatTimeoutMs : RUNNER_HEARTBEAT_TIMEOUT_MS,
			status,
			releasedAt: typeof parsed.releasedAt === "string" ? parsed.releasedAt : undefined,
			releasedReason: typeof parsed.releasedReason === "string" ? parsed.releasedReason : undefined,
			recoveredFrom: parsed.recoveredFrom && typeof parsed.recoveredFrom === "object" && typeof parsed.recoveredFrom.ownerPid === "number" && typeof parsed.recoveredFrom.ownerSessionMarker === "string" && typeof parsed.recoveredFrom.heartbeatAt === "string"
				? {
					ownerPid: parsed.recoveredFrom.ownerPid,
					ownerSessionMarker: parsed.recoveredFrom.ownerSessionMarker,
					heartbeatAt: parsed.recoveredFrom.heartbeatAt,
					status: parsed.recoveredFrom.status === "released" ? "released" : "active",
				}
				: undefined,
		};
	} catch {
		return undefined;
	}
}

function lockHeartbeatExpired(lock: MissionRunnerLockArtifact): boolean {
	const heartbeatAt = Date.parse(lock.heartbeatAt);
	if (!Number.isFinite(heartbeatAt)) return true;
	const timeout = Number.isFinite(lock.heartbeatTimeoutMs) && lock.heartbeatTimeoutMs > 0 ? lock.heartbeatTimeoutMs : RUNNER_HEARTBEAT_TIMEOUT_MS;
	return Date.now() - heartbeatAt > timeout;
}

function isSameLockOwner(lock: MissionRunnerLockArtifact): boolean {
	return lock.ownerPid === process.pid && lock.ownerSessionMarker === parentSessionMarker();
}

function writeRunnerLock(cwd: string, missionId: string, lock: MissionRunnerLockArtifact): void {
	writeJson(runnerLockFile(cwd, missionId), lock);
}

function upsertRunnerLockHeartbeat(cwd: string, missionId: string): void {
	const existing = readRunnerLock(cwd, missionId);
	if (!existing || !isSameLockOwner(existing) || existing.status !== "active") return;
	existing.heartbeatAt = nowIso();
	writeRunnerLock(cwd, missionId, existing);
}

function releaseRunnerLock(cwd: string, missionId: string, reason: string): void {
	const existing = readRunnerLock(cwd, missionId);
	if (!existing || !isSameLockOwner(existing)) return;
	existing.status = "released";
	existing.releasedAt = nowIso();
	existing.releasedReason = reason;
	existing.heartbeatAt = existing.releasedAt;
	writeRunnerLock(cwd, missionId, existing);
}

async function acquireRunnerLock(cwd: string, mission: MissionState): Promise<{ ok: true; lock: MissionRunnerLockArtifact; recoveredStale: boolean } | { ok: false; reason: string; lock?: MissionRunnerLockArtifact }> {
	return await withRunnerLockGuard(cwd, mission.id, () => {
		const existing = readRunnerLock(cwd, mission.id);
		if (existing && existing.status === "active") {
			if (isSameLockOwner(existing)) {
				existing.heartbeatAt = nowIso();
				writeRunnerLock(cwd, mission.id, existing);
				return { ok: true, lock: existing, recoveredStale: false };
			}
			const alive = isPidAlive(existing.ownerPid);
			const orphanedPlannedLock = mission.status === "planned" && !hasMissionExecutionStarted(cwd, mission);
			const stale = alive === false || lockHeartbeatExpired(existing) || orphanedPlannedLock;
			if (!stale) return { ok: false, reason: `Mission ${mission.id} is already owned by pid ${existing.ownerPid} (${existing.ownerSessionMarker}) with recent heartbeat ${existing.heartbeatAt}.`, lock: existing };
			const recovered: MissionRunnerLockArtifact = {
				schemaVersion: 1,
				missionId: mission.id,
				ownerPid: process.pid,
				ownerSessionMarker: parentSessionMarker(),
				acquiredAt: nowIso(),
				heartbeatAt: nowIso(),
				heartbeatTimeoutMs: RUNNER_HEARTBEAT_TIMEOUT_MS,
				status: "active",
				recoveredFrom: {
					ownerPid: existing.ownerPid,
					ownerSessionMarker: existing.ownerSessionMarker,
					heartbeatAt: existing.heartbeatAt,
					status: existing.status,
				},
			};
			writeRunnerLock(cwd, mission.id, recovered);
			return { ok: true, lock: recovered, recoveredStale: true };
		}
		const lock: MissionRunnerLockArtifact = {
			schemaVersion: 1,
			missionId: mission.id,
			ownerPid: process.pid,
			ownerSessionMarker: parentSessionMarker(),
			acquiredAt: nowIso(),
			heartbeatAt: nowIso(),
			heartbeatTimeoutMs: RUNNER_HEARTBEAT_TIMEOUT_MS,
			status: "active",
		};
		writeRunnerLock(cwd, mission.id, lock);
		return { ok: true, lock, recoveredStale: false };
	});
}

function hasMissionExecutionStarted(cwd: string, mission: MissionState): boolean {
	if (typeof mission.executionStartedAt === "string" && mission.executionStartedAt.trim()) return true;
	const logFile = path.join(missionDir(cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return false;
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: unknown };
			if (typeof event.type === "string" && EXECUTION_STARTED_EVENT_TYPES.has(event.type)) return true;
		} catch {
			// Ignore malformed historical log entries; execution-start detection is best-effort for legacy missions.
		}
	}
	return false;
}

function markMissionExecutionStarted(mission: MissionState): MissionState {
	if (mission.executionStartedAt) return mission;
	return { ...mission, executionStartedAt: nowIso() };
}

function hasRunnablePersistedPlan(cwd: string, mission: MissionState): boolean {
	try {
		const hasFeature = missionFeatureList(mission).length > 0;
		return hasFeature && fs.existsSync(path.join(missionDir(cwd, mission.id), "plan/validation-contract.json"));
	} catch {
		return false;
	}
}

function missionFeatureList(mission: MissionState): MissionFeature[] {
	return missionMilestones(mission).flatMap((milestone) => milestone.features);
}

function missionMilestones(mission: MissionState): MissionMilestone[] {
	if (Array.isArray(mission.milestones) && mission.milestones.length > 0) return mission.milestones;
	return [];
}

function effectiveMilestoneValidationFailureLimit(mission: MissionState, milestone: MissionMilestone): number {
	const milestoneLimit = milestone.validationState?.failureLimit;
	if (typeof milestoneLimit === "number" && Number.isInteger(milestoneLimit) && milestoneLimit > 0) return milestoneLimit;
	const missionLimit = mission.validation?.failureLimit;
	if (typeof missionLimit === "number" && Number.isInteger(missionLimit) && missionLimit > 0) return missionLimit;
	return DEFAULT_MILESTONE_VALIDATION_FAILURE_LIMIT;
}

function milestoneValidationFailureCount(milestone: MissionMilestone): number {
	const count = milestone.validationState?.failureCount;
	return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

function incrementMilestoneValidationFailureCount(milestone: MissionMilestone): number {
	const next = milestoneValidationFailureCount(milestone) + 1;
	milestone.validationState = { ...milestone.validationState, failureCount: next };
	return next;
}

function setMilestoneValidationRunId(milestone: MissionMilestone, runId: string): void {
	milestone.validationRunId = runId;
	milestone.validationState = { ...milestone.validationState, runId };
}

function mergeMissionFeatureState(primary: MissionFeature, secondary: MissionFeature): MissionFeature {
	const statusRank: Record<ItemStatus, number> = { pending: 0, failed: 1, running: 2, skipped: 3, complete: 4 };
	const status = statusRank[secondary.status] > statusRank[primary.status] ? secondary.status : primary.status;
	return {
		...primary,
		...secondary,
		status,
		runId: secondary.runId ?? primary.runId,
		validationRunId: secondary.validationRunId ?? primary.validationRunId,
		userTestingRunId: secondary.userTestingRunId ?? primary.userTestingRunId,
		reviewerRunIds: secondary.reviewerRunIds ?? primary.reviewerRunIds,
		commit: secondary.commit ?? primary.commit,
		userTestingPending: secondary.userTestingPending ?? primary.userTestingPending,
		reviewerPending: secondary.reviewerPending ?? primary.reviewerPending,
	};
}

function syncMissionFeatureCopies(mission: MissionState): MissionState {
	if (!Array.isArray(mission.milestones) || mission.milestones.length === 0) return mission;
	const mergedById = new Map<string, MissionFeature>();
	for (const feature of mission.features ?? []) mergedById.set(feature.id, feature);
	for (const milestone of mission.milestones) {
		for (const feature of milestone.features) {
			const existing = mergedById.get(feature.id);
			mergedById.set(feature.id, existing ? mergeMissionFeatureState(existing, feature) : feature);
		}
	}
	mission.milestones = mission.milestones.map((milestone) => {
		const features = milestone.features.map((feature) => mergedById.get(feature.id) ?? feature);
		const status: ItemStatus = features.every((feature) => feature.status === "complete" || feature.status === "skipped")
			? "complete"
			: features.some((feature) => feature.status === "running")
				? "running"
				: features.some((feature) => feature.status === "failed")
					? "failed"
					: "pending";
		return { ...milestone, status, features };
	});
	delete mission.features;
	return mission;
}

function normalizeMissionShape(mission: MissionState): MissionState {
	return syncMissionFeatureCopies(mission);
}

function stripLegacyFeatureValidationState(feature: MissionFeature): MissionFeature {
	const persisted = { ...feature };
	delete persisted.validationRunId;
	delete persisted.userTestingRunId;
	delete persisted.reviewerRunIds;
	delete persisted.userTesting;
	delete persisted.reviewers;
	delete persisted.userTestingPending;
	delete persisted.reviewerPending;
	return persisted;
}

function missionForPersistence(mission: MissionState): MissionState {
	const persisted = normalizeMissionShape({ ...mission, milestones: mission.milestones?.map((milestone) => ({ ...milestone, features: milestone.features.map((feature) => ({ ...feature })) })) });
	if (Array.isArray(persisted.milestones) && persisted.milestones.length > 0) {
		delete persisted.features;
		persisted.milestones = persisted.milestones.map((milestone) => ({ ...milestone, features: milestone.features.map(stripLegacyFeatureValidationState) }));
	}
	return persisted;
}

function normalizeMissionForRuntime(cwd: string, mission: MissionState): MissionState {
	const normalized = normalizeMissionShape(mission);
	if (normalized.status === "planning" && hasRunnablePersistedPlan(cwd, normalized)) return { ...normalized, status: "planned" };
	return normalized;
}

function loadMission(cwd: string, id: string): MissionState {
	return normalizeMissionForRuntime(cwd, readJson<MissionState>(path.join(missionDir(cwd, id), "mission.json")));
}

function saveMission(cwd: string, mission: MissionState): void {
	normalizeMissionShape(mission);
	mission.updatedAt = nowIso();
	writeJson(path.join(missionDir(cwd, mission.id), "mission.json"), missionForPersistence(mission));
	const existingOrchestrator = readOrchestratorSessionRecord(cwd, mission.id);
	if (existingOrchestrator && existingOrchestrator.active !== isActiveMissionStatus(mission.status)) {
		writeOrchestratorSessionRecord(cwd, mission.id, {
			sessionId: existingOrchestrator.sessionId,
			sessionPath: existingOrchestrator.sessionPath,
			createdAt: existingOrchestrator.createdAt,
			active: isActiveMissionStatus(mission.status),
		});
	}
}

function listMissions(cwd: string): MissionState[] {
	const root = missionRoot(cwd);
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.map((name) => path.join(root, name, "mission.json"))
		.filter((file) => fs.existsSync(file))
		.map((file) => normalizeMissionForRuntime(cwd, readJson<MissionState>(file)))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isMissionForCwd(mission: MissionState, cwd: string): boolean {
	return path.resolve(mission.cwd) === path.resolve(cwd);
}

function latestMission(cwd: string): MissionState | undefined {
	const missions = listMissions(cwd);
	return missions.find((mission) => isMissionForCwd(mission, cwd)) ?? missions[0];
}

function latestVisibleMission(cwd: string): MissionState | undefined {
	const missions = listMissions(cwd).filter((mission) => mission.status !== "complete" && !isMissionCleared(cwd, mission.id));
	return missions.find((mission) => isMissionForCwd(mission, cwd)) ?? missions[0];
}

function isActiveMissionStatus(status: Status): boolean {
	return status === "planning" || status === "planned" || status === "running" || status === "paused" || status === "blocked";
}

function activeMissionFromState(cwd: string, state?: MissionOrchestratorSessionState): MissionState | undefined {
	const ids = [state?.activeMissionId, state?.activePlanningMissionId, state?.activeRunningMissionId, state?.lastMissionId].filter((id): id is string => Boolean(id));
	for (const id of ids) {
		try {
			const mission = loadMission(cwd, id);
			if (isActiveMissionStatus(mission.status)) return mission;
		} catch {
			// Ignore stale session entries that point at missions no longer present in this checkout.
		}
	}
	const active = listMissions(cwd).filter((mission) => isActiveMissionStatus(mission.status) && !isMissionCleared(cwd, mission.id));
	return active.find((mission) => isMissionForCwd(mission, cwd)) ?? active[0];
}

function buildOrchestratorState(cwd: string, mission?: MissionState, overrides: Partial<MissionOrchestratorSessionState> = {}): MissionOrchestratorSessionState {
	const hasOverride = (key: keyof MissionOrchestratorSessionState) => Object.prototype.hasOwnProperty.call(overrides, key);
	const activeMissionId = hasOverride("activeMissionId") ? overrides.activeMissionId : mission?.id;
	const activePlanningMissionId = hasOverride("activePlanningMissionId") ? overrides.activePlanningMissionId : mission?.status === "planning" ? mission.id : undefined;
	const activeRunningMissionId = hasOverride("activeRunningMissionId") ? overrides.activeRunningMissionId : mission?.status === "running" || mission?.status === "paused" ? mission.id : undefined;
	return {
		schemaVersion: 1,
		cwd,
		updatedAt: nowIso(),
		activeMissionId,
		activePlanningMissionId,
		activeRunningMissionId,
		lastMissionId: overrides.lastMissionId ?? mission?.id ?? activeMissionId,
		context: mission
			? {
				id: mission.id,
				title: mission.title,
				status: mission.status,
				currentMilestoneId: mission.currentMilestoneId,
				currentFeatureId: mission.currentFeatureId,
			}
			: overrides.context,
	};
}

function latestOrchestratorStateFromSession(cwd: string, entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): MissionOrchestratorSessionState | undefined {
	let state: MissionOrchestratorSessionState | undefined;
	let legacyPlanningId: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === ORCHESTRATOR_STATE_ENTRY) {
			const data = entry.data as Partial<MissionOrchestratorSessionState> | undefined;
			if (data?.schemaVersion === 1 && (!data.cwd || data.cwd === cwd)) state = { ...data, schemaVersion: 1, cwd, updatedAt: data.updatedAt || nowIso() } as MissionOrchestratorSessionState;
		}
		if (entry.customType === LEGACY_ACTIVE_PLANNING_ENTRY) {
			legacyPlanningId = (entry.data as { id?: string } | undefined)?.id;
		}
	}
	if (!state && legacyPlanningId) return buildOrchestratorState(cwd, undefined, { activeMissionId: legacyPlanningId, activePlanningMissionId: legacyPlanningId, lastMissionId: legacyPlanningId });
	return state;
}

function lightweightMissionContext(cwd: string, state?: MissionOrchestratorSessionState): string | undefined {
	const mission = activeMissionFromState(cwd, state);
	if (!mission) return undefined;
	const dir = missionDir(cwd, mission.id);
	const mode = mission.status === "planning" ? "planning" : mission.status === "running" || mission.status === "paused" ? "execution" : "available";
	return [
		"[MISSION ORCHESTRATOR CONTEXT]",
		`Active mission (${mode}): ${mission.id} — ${mission.title} [${mission.status}]`,
		`Mission directory: ${dir}`,
		mission.currentMilestoneId ? `Current milestone: ${mission.currentMilestoneId}` : undefined,
		mission.currentFeatureId ? `Current feature: ${mission.currentFeatureId}` : undefined,
		mission.status === "planning" ? "The current assistant/session is the mission orchestrator. Continue planning inline when the user discusses this mission." : undefined,
		"Use mission tools when the user asks about this mission; /missions run and mission_start_execution are the confirmation gate before implementation starts.",
		"This is lightweight context only: answer unrelated user requests normally and do not force the conversation into mission planning unless relevant.",
	].filter((line): line is string => Boolean(line)).join("\n");
}

function runningMissionOrchestratorContext(cwd: string, mission: MissionState): string {
	return [
		"[RUNNING MISSION ORCHESTRATOR SESSION]",
		"This is the dedicated orchestrator chat for a running or active mission.",
		`Mission: ${mission.id} — ${mission.title} [${mission.status}]`,
		`Mission directory: ${missionDir(cwd, mission.id)}`,
		`Current feature: ${mission.currentFeatureId ?? "not set"}`,
		"",
		"Your role:",
		"- Coordinate, diagnose, redirect, pause/resume, and revise this mission.",
		"- Do not implement repository code directly unless the user explicitly asks for manual repair outside mission execution.",
		"- Use mission status/artifacts first when discussing active execution.",
		"- Prefer feature-level recovery: failed validation keeps the same feature incomplete for another attempt unless user requests new scope.",
		"",
		"Initial mission status:",
		summarizeMission(mission),
	].join("\n");
}

function missionPlanningKickoffContext(cwd: string, goal: string): string {
	return [
		"[MISSION ORCHESTRATOR REQUEST]",
		"The user invoked /missions in the current session.",
		"You are the mission orchestrator in this same ongoing conversation; do not assume a detached planning mode or wizard UI.",
		`Target repository cwd: ${cwd}`,
		`Current time: ${nowIso()}`,
		"",
		"User goal or context:",
		goal || "The user wants to discuss or continue mission planning.",
		"",
		"Use the mission-orchestrator skill for mission planning. Do not write application code while planning.",
		"First brainstorm with the user: ask clarifying questions, push back on scope, surface tradeoffs, and iterate in normal chat.",
		"Do not call mission_write_plan merely because /missions was invoked. Call mission_write_plan only when you judge the plan and validation contract are mature enough to persist, or when the user explicitly asks you to save the draft.",
		"After the user has reviewed the persisted plan, use mission_start_execution as the single explicit start/run confirmation gate before implementation begins.",
		"The user may ask unrelated questions at any time; answer those normally and return to mission planning only when relevant.",
	].join("\n");
}

function readClearedMissions(cwd: string): ClearedMissionsState {
	const file = clearedMissionsFile(cwd);
	if (!fs.existsSync(file)) return { schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [] };
	const parsed = readJson<Partial<ClearedMissionsState>>(file);
	return {
		schemaVersion: 1,
		updatedAt: parsed.updatedAt || nowIso(),
		clearedMissionIds: Array.isArray(parsed.clearedMissionIds) ? [...new Set(parsed.clearedMissionIds.filter((id): id is string => typeof id === "string"))] : [],
	};
}

function writeClearedMissions(cwd: string, state: ClearedMissionsState): void {
	writeJson(clearedMissionsFile(cwd), { ...state, schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [...new Set(state.clearedMissionIds)].sort() });
}

function resolveRoleModel(cwd: string, mission: MissionState, role: MissionRole): string {
	const missionModel = mission.models?.[role];
	if (missionModel && missionModel !== "default") return missionModel;
	return readMissionGlobalSettings(cwd).models[role];
}

function findMissionModelReference(modelReference: string, models: Model<Api>[]): Model<Api> | undefined {
	const reference = modelReference.trim();
	if (!reference) return undefined;

	const slash = reference.indexOf("/");
	if (slash > 0) {
		const provider = reference.slice(0, slash);
		const modelId = reference.slice(slash + 1);
		const canonical = models.find((model) => model.provider === provider && model.id === modelId);
		if (canonical) return canonical;
	}

	const exactIdMatches = models.filter((model) => model.id === reference);
	if (exactIdMatches.length === 1) return exactIdMatches[0];

	const exactNameMatches = models.filter((model) => model.name === reference);
	if (exactNameMatches.length === 1) return exactNameMatches[0];

	return undefined;
}

function describeModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

async function applyGlobalOrchestratorModelDefault(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<string | undefined> {
	const modelReference = readMissionGlobalSettings(ctx.cwd).models.orchestrator;
	if (!modelReference || modelReference === "default") return undefined;

	ctx.modelRegistry.refresh();
	const model = findMissionModelReference(modelReference, ctx.modelRegistry.getAll());
	if (!model) {
		const warning = `Mission orchestrator model default '${modelReference}' was not applied: no matching model was found. Use a provider/model reference from /model or set /missions models orchestrator default.`;
		ctx.ui.notify(warning, "warning");
		return warning;
	}

	if (ctx.model?.provider === model.provider && ctx.model.id === model.id) {
		return `Mission orchestrator model default already active: ${describeModel(model)}.`;
	}

	const switched = await pi.setModel(model);
	if (!switched) {
		const warning = `Mission orchestrator model default '${modelReference}' resolved to ${describeModel(model)} but was not applied because credentials are unavailable for provider '${model.provider}'. Configure credentials or set /missions models orchestrator default.`;
		ctx.ui.notify(warning, "warning");
		return warning;
	}

	const message = `Mission orchestrator model default applied: ${describeModel(model)}.`;
	ctx.ui.notify(message, "info");
	return message;
}

function isMissionCleared(cwd: string, id: string): boolean {
	return readClearedMissions(cwd).clearedMissionIds.includes(id);
}

function clearCompletedMissions(cwd: string): ClearCompletedResult {
	const missions = listMissions(cwd);
	const completedIds = missions.filter((mission) => mission.status === "complete").map((mission) => mission.id);
	const state = readClearedMissions(cwd);
	const existing = new Set(state.clearedMissionIds);
	const clearedIds = completedIds.filter((id) => !existing.has(id));
	const alreadyClearedIds = completedIds.filter((id) => existing.has(id));
	if (clearedIds.length > 0) {
		writeClearedMissions(cwd, { ...state, clearedMissionIds: [...state.clearedMissionIds, ...clearedIds] });
		for (const id of clearedIds) appendEvent(missionDir(cwd, id), "mission_cleared", { clearedStateFile: clearedMissionsFile(cwd) });
	}
	const text = clearedIds.length > 0
		? `Cleared ${clearedIds.length} completed mission${clearedIds.length === 1 ? "" : "s"}: ${clearedIds.join(", ")}. Artifacts were not deleted and statuses remain complete.`
		: completedIds.length > 0
			? `No completed missions to clear; ${alreadyClearedIds.length} completed mission${alreadyClearedIds.length === 1 ? " is" : "s are"} already cleared.`
			: "No completed missions to clear.";
	return { clearedIds, alreadyClearedIds, completedIds, text };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
	return { command: process.execPath, args };
}

function textFromMessage(msg: Message): string {
	if (msg.role !== "assistant") return "";
	return msg.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function runPiChild(options: {
	cwd: string;
	prompt: string;
	model?: string;
	systemPromptFiles: string[];
	transcriptFile: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<RunResult> {
	ensureDir(path.dirname(options.transcriptFile));
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.model && options.model !== "default") args.push("--model", options.model);
	for (const file of options.systemPromptFiles) {
		if (fs.existsSync(file)) args.push("--append-system-prompt", file);
	}
	args.push(options.prompt);

	const result: RunResult = { exitCode: 0, messages: [], stderr: "", finalText: "" };
	await new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let buffer = "";
		const transcript = fs.createWriteStream(options.transcriptFile, { flags: "a" });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			transcript.write(`${line}\n`);
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				result.messages.push(msg);
				const text = textFromMessage(msg);
				if (text) {
					result.finalText = text;
					options.onUpdate?.(text);
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 0;
			transcript.end();
			resolve();
		});
		proc.on("error", (error) => {
			result.exitCode = 1;
			result.stderr += String(error);
			transcript.end();
			resolve();
		});
		if (options.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
			};
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
	});
	return result;
}

async function gitPorcelain(cwd: string): Promise<string> {
	const result = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
		const proc = spawn("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("close", () => resolve({ stdout, stderr }));
		proc.on("error", (e) => resolve({ stdout, stderr: String(e) }));
	});
	return result.stdout.trim();
}

async function gitHead(cwd: string): Promise<string | undefined> {
	return await new Promise((resolve) => {
		const proc = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : undefined));
		proc.on("error", () => resolve(undefined));
	});
}

function latestBlockFromArtifacts(mission: MissionState): MissionBlockMetadata | undefined {
	if (mission.status === "complete") return undefined;
	if (mission.latestBlock) return mission.latestBlock;
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return undefined;
	let latest: MissionBlockMetadata | undefined;
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; data?: MissionBlockMetadata };
			if (event.type === "mission_block_recorded" && event.data?.schemaVersion === 1) latest = event.data;
		} catch {
			// Ignore malformed historical log entries; status rendering should be best-effort.
		}
	}
	return latest;
}

function compareRunIds(a: string, b: string): number {
	const aPrefix = Number.parseInt(a, 10);
	const bPrefix = Number.parseInt(b, 10);
	if (Number.isFinite(aPrefix) && Number.isFinite(bPrefix) && aPrefix !== bPrefix) return aPrefix - bPrefix;
	return a.localeCompare(b);
}

function unfinishedValidatorRunContextsFromEvents(mission: MissionState, recordedRunIds: Set<string>): MissionRunContext[] {
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return [];
	const starts = new Map<string, { milestoneId: string }>();
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; data?: { milestoneId?: unknown; runId?: unknown } };
			const runId = typeof event.data?.runId === "string" ? event.data.runId : undefined;
			const milestoneId = typeof event.data?.milestoneId === "string" ? event.data.milestoneId : undefined;
			if (!runId || !milestoneId) continue;
			if (event.type === "validator_started") starts.set(runId, { milestoneId });
			if (event.type === "validator_finished") starts.delete(runId);
		} catch {
			// Ignore malformed historical log entries; status rendering should be best-effort.
		}
	}
	return [...starts.entries()]
		.filter(([runId]) => !recordedRunIds.has(runId))
		.map(([runId, started]) => {
			const milestone = missionMilestones(mission).find((m) => m.id === started.milestoneId);
			return {
				label: "Current validator run",
				runId,
				runDir: path.join(missionDir(mission.cwd, mission.id), "runs", runId),
				kind: "validator" as const,
				itemId: started.milestoneId,
				itemTitle: milestone?.title ?? started.milestoneId,
				status: "running",
			};
		});
}

function missionRunContexts(mission: MissionState): MissionRunContext[] {
	const contexts: MissionRunContext[] = [];
	const recordedRunIds = new Set<string>();
	for (const milestone of missionMilestones(mission)) {
		for (const feature of milestone.features) {
			if (feature.runId) {
				recordedRunIds.add(feature.runId);
				contexts.push({
					label: `${feature.status === "running" ? "Current" : "Last"} worker run`,
					runId: feature.runId,
					runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId),
					kind: "worker",
					itemId: feature.id,
					itemTitle: feature.title,
					status: feature.status,
				});
			}
			if (feature.validationRunId) {
				recordedRunIds.add(feature.validationRunId);
				contexts.push({
					label: `${feature.status === "running" ? "Current" : "Last"} validator run`,
					runId: feature.validationRunId,
					runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.validationRunId),
					kind: "validator",
					itemId: feature.id,
					itemTitle: feature.title,
					status: feature.status,
				});
			}
			if (feature.userTestingRunId) {
				recordedRunIds.add(feature.userTestingRunId);
				contexts.push({
					label: `${feature.status === "running" ? "Current" : "Last"} user-testing run`,
					runId: feature.userTestingRunId,
					runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.userTestingRunId),
					kind: "user-testing-validator",
					itemId: feature.id,
					itemTitle: feature.title,
					status: feature.status,
				});
			}
		}
		if (milestone.validationRunId) {
			recordedRunIds.add(milestone.validationRunId);
			contexts.push({
				label: `${milestone.status === "running" ? "Current" : "Last"} validator run`,
				runId: milestone.validationRunId,
				runDir: path.join(missionDir(mission.cwd, mission.id), "runs", milestone.validationRunId),
				kind: "validator",
				itemId: milestone.id,
				itemTitle: milestone.title,
				status: milestone.status,
			});
		}
	}
	contexts.push(...unfinishedValidatorRunContextsFromEvents(mission, recordedRunIds));
	return contexts.sort((a, b) => compareRunIds(a.runId, b.runId));
}

function currentOrLastRunContext(mission: MissionState): MissionRunContext | undefined {
	const contexts = missionRunContexts(mission);
	return contexts.filter((ctx) => ctx.status === "running").at(-1) ?? contexts.at(-1);
}

function isPidAlive(pid: number): boolean | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

function runArtifactStatus(run: MissionRunContext): string | undefined {
	const file = path.join(run.runDir, run.kind === "worker" ? "handoff.json" : run.kind === "user-testing-validator" ? "user-testing-report.json" : "validation-report.json");
	if (!fs.existsSync(file)) return undefined;
	try {
		const parsed = readJson<{ status?: unknown }>(file);
		return typeof parsed.status === "string" && parsed.status.trim() ? parsed.status.trim() : undefined;
	} catch {
		return undefined;
	}
}

function synthesizeWorkerHandoffArtifacts(runDir: string, feature: MissionFeature, result: RunResult, commit: string | undefined): any {
	const handoffFile = path.join(runDir, "handoff.json");
	const handoffMdFile = path.join(runDir, "handoff.md");
	const synthesized = {
		featureId: feature.id,
		status: result.exitCode === 0 ? "complete" : "blocked",
		commit: commit ?? "unknown",
		summary: "Worker exited without handoff artifacts; orchestrator synthesized this handoff from runner metadata so validation/retry flow can continue.",
		implemented: [] as string[],
		leftUndone: ["Original worker did not produce required handoff.json/handoff.md."],
		filesChanged: [] as string[],
		commandsRun: [] as Array<{ command: string; exitCode?: number; notes?: string }>,
		issuesDiscovered: [] as string[],
		procedureCompliance: {
			readMissionContext: false,
			checkedGitStatusBeforeWork: false,
			ranRequiredValidation: false,
			committedChanges: Boolean(commit),
			updatedHandoff: false,
		},
		risks: ["Original worker did not produce required handoff.json/handoff.md; inspect transcript.jsonl for details."],
		synthesizedByOrchestrator: true,
		exitCode: result.exitCode,
	};
	writeJson(handoffFile, synthesized);
	fs.writeFileSync(handoffMdFile, [
		`# ${feature.id} Handoff`,
		"",
		"## Status",
		String(synthesized.status),
		"",
		"## Summary",
		synthesized.summary,
		"",
		"## Commit",
		commit ?? "not recorded",
		"",
		"## Risks",
		`- ${synthesized.risks[0]}`,
		"",
		"## Follow-up",
		"Inspect this run's transcript.jsonl and stderr.txt. Treat this as lower-confidence than a worker-authored handoff.",
	].join("\n"));
	return synthesized;
}

function ensureValidatorFailureReportArtifacts(runDir: string, milestone: MissionMilestone, result: RunResult, report: any, schemaError?: string): any {
	const reportFile = path.join(runDir, "validation-report.json");
	const reportMdFile = path.join(runDir, "validation-report.md");
	const hasStructuredReport = report && typeof report === "object" && typeof report.status === "string";
	if (hasStructuredReport) {
		if (!fs.existsSync(reportMdFile)) {
			const status = String(report.status ?? "fail");
			const summary = typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : "Validator reported a non-pass result.";
			fs.writeFileSync(reportMdFile, `# Validation Report\n\n- Milestone: ${milestone.id} - ${milestone.title}\n- Status: ${status}\n\n## Summary\n${summary}\n`);
		}
		return report;
	}
	const finalText = result.finalText.trim();
	const synthesized = {
		milestoneId: milestone.id,
		status: "fail",
		summary: schemaError || finalText || "Validator exited without a parseable validation-report.json artifact.",
		commandsRun: [] as Array<{ command: string; exitCode: number; notes?: string }>,
		assertions: [],
		defects: [
			{
				id: "SYNTH-VALIDATOR-ARTIFACT",
				severity: "critical",
				title: "Missing or invalid validator report artifact",
				description: schemaError || (finalText ? `Validator did not produce parseable JSON, but final response was: ${finalText.slice(0, 2000)}` : "The validator run did not produce a parseable validation-report.json file. See transcript.jsonl and stderr.txt for failure details."),
				reproduction: "Inspect validation-report.json, validation-report.md, transcript.jsonl, and stderr.txt in this run directory."
			}
		],
		procedureFindings: [],
		recommendation: "fix",
		risks: ["Validation output was synthesized by the orchestrator due to missing/invalid validator artifacts."]
	};
	writeJson(reportFile, synthesized);
	if (!fs.existsSync(reportMdFile)) {
		fs.writeFileSync(reportMdFile, [
			"# Validation Report",
			"",
			`- Milestone: ${milestone.id} - ${milestone.title}`,
			`- Status: fail`,
			`- Validator exit code: ${result.exitCode}`,
			"",
			"## Summary",
			synthesized.summary,
			"",
			"## Follow-up",
			"Inspect transcript.jsonl and stderr.txt in this run directory for root cause details."
		].join("\n"));
	}
	return synthesized;
}

function classifyMissionRunLifecycle(cwd: string, mission: MissionState): MissionRunLifecycleClassification {
	const run = currentOrLastRunContext(mission);
	const artifactStatus = run ? runArtifactStatus(run) : undefined;
	const block = latestBlockFromArtifacts(mission);
	if (block && run && block.runId === run.runId) return { state: "blocked", run, reason: "mission block artifact recorded" };
	if (mission.status === "blocked") return { state: "blocked", run, reason: "mission status is blocked" };
	if (mission.status === "complete") return { state: "completed", run, reason: "mission status is complete" };
	const lock = readRunnerLock(cwd, mission.id);
	if (lock?.status === "active" && !lockHeartbeatExpired(lock)) {
		const alive = isPidAlive(lock.ownerPid);
		if (alive !== false) return { state: "active", run, reason: `runner lock owned by pid ${lock.ownerPid} with recent heartbeat ${lock.heartbeatAt}` };
	}
	if (artifactStatus === "complete") return { state: "completed", run, reason: "terminal run artifact status is complete" };
	if (artifactStatus === "blocked" || artifactStatus === "failed") return { state: "blocked", run, reason: `terminal run artifact status is ${artifactStatus}` };
	if (!run) return { state: mission.status === "running" ? "interrupted" : "completed", reason: mission.status === "running" ? "mission marked running without recorded run context" : "no active run context" };
	const ownership = mission.activeRun;
	if (ownership && ownership.runId === run.runId && mission.status === "running") {
		if (isMissionRunActive(cwd, mission.id)) return { state: "active", run, reason: "runtime has an active mission execution lock" };
		const alive = isPidAlive(ownership.parentPid);
		if (alive === true) return { state: "interrupted", run, reason: `owner pid ${ownership.parentPid} is alive but no in-process execution lock exists` };
		if (alive === undefined) return { state: "interrupted", run, reason: "owner liveness check unavailable and no in-process execution lock exists" };
		return { state: "interrupted", run, reason: `owner pid ${ownership.parentPid} is not alive and no terminal artifact was found` };
	}
	if (run.status === "running" || mission.status === "running") return { state: "interrupted", run, reason: "running status persisted without live ownership evidence" };
	return { state: "completed", run, reason: "latest run context is not running" };
}

function describeBlock(block: MissionBlockMetadata): string {
	return `${block.reasonCategory} on ${block.kind} ${block.failedItemId} (${block.failedItemTitle}); run ${block.runId}${block.status ? ` reported ${block.status}` : ""}`;
}

function nextSuggestedAction(mission: MissionState, lifecycle: MissionRunLifecycleClassification, run?: MissionRunContext, block?: MissionBlockMetadata): string {
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

function missionFooterProgressBar(completed: number, total: number, width = 4): string {
	if (total <= 0) return "▱".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((completed / total) * width)));
	return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

function missionFooterStatusText(mission: MissionControlMissionView): string {
	if (mission.status === "blocked" && mission.currentBlock) return `${mission.status} · ${mission.currentBlock.reasonCategory}`;
	if (mission.status === "failed" && mission.currentBlock) return `${mission.status} · ${mission.currentBlock.reasonCategory}`;
	return mission.status;
}

function chooseFooterMission(vm: MissionControlViewModel, preferredMissionId?: string): MissionControlMissionView | undefined {
	if (preferredMissionId) {
		const preferred = vm.missions.find((entry) => entry.id === preferredMissionId && entry.status !== "complete");
		if (preferred) return preferred;
	}
	return vm.sections.find((section) => section.id !== "completed" && section.missions.length > 0)?.missions[0];
}

function updateWidget(ctx: ExtensionContext, mission?: MissionState): void {
	// Mission Control is now the rich mission visibility surface. Keep only the
	// compact footer/status indicator here and always clear the legacy mission
	// widget so stale rich mission UI cannot survive reload, clear, block, or
	// completion transitions.
	ctx.ui.setWidget("missions", undefined);
	// Clear first so stale footer text from an older active/cleared mission cannot
	// survive if anything below throws while reconciling disk artifacts.
	ctx.ui.setStatus("missions", undefined);
	const vm = loadMissionControlViewModel(ctx.cwd);
	const selected = chooseFooterMission(vm, mission && !isMissionCleared(mission.cwd, mission.id) ? mission.id : undefined);
	if (!selected) return;
	const runningCount = vm.sections.find((section) => section.id === "running")?.missions.filter((entry) => entry.id !== selected.id).length ?? 0;
	const blockedCount = vm.sections.find((section) => section.id === "blockedFailed")?.missions.filter((entry) => entry.id !== selected.id).length ?? 0;
	const parts = [
		`mission: ${missionFooterStatusText(selected)}`,
		`${selected.progress.completed}/${selected.progress.total} ${missionFooterProgressBar(selected.progress.completed, selected.progress.total)}`,
	];
	if (runningCount > 0) parts.push(`+${runningCount} running`);
	if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
	ctx.ui.setStatus("missions", truncateToWidth(parts.join(" · "), 120));
}

function clearMissionRunStatus(ctx: ExtensionContext): void {
	// Child pi output is already captured in transcript/stderr artifacts. Do not
	// mirror it into a widget: widgets consume scrollback space and can push the
	// Mission Control component off screen while background workers are active.
	ctx.ui.setWidget("missions-run", undefined);
	ctx.ui.setStatus("missions-run", undefined);
}

function updateMissionRunStatus(ctx: ExtensionContext, _label: string, _text?: string): void {
	// The compact `missions` footer item is the only always-on mission status.
	// Child output already streams into transcript/stderr artifacts and is visible
	// through Mission Control detail. Mirroring it in the footer creates noisy,
	// stale duplicate status text during long-running missions.
	ctx.ui.setWidget("missions-run", undefined);
	ctx.ui.setStatus("missions-run", undefined);
}

function mark(status: string): string {
	if (status === "complete") return "✓";
	if (status === "running") return "⏳";
	if (status === "failed" || status === "blocked") return "✗";
	if (status === "skipped") return "↷";
	return "○";
}

function existingPaths(paths: string[]): string[] {
	return paths.filter((file) => fs.existsSync(file));
}

function classifyWorkerBlock(result: RunResult, handoff: any, dirty: string): BlockReasonCategory {
	if (result.exitCode !== 0) return "child_exit_nonzero";
	if (!handoff) return "missing_handoff";
	if (dirty) return "dirty_worktree";
	return "worker_reported_blocked";
}

function classifyValidatorBlock(result: RunResult, report: any): BlockReasonCategory {
	if (result.exitCode !== 0) return "child_exit_nonzero";
	if (!report) return "missing_validation_report";
	return "validator_report_failed";
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
	const packet = {
		schemaVersion: 1,
		missionId: mission.id,
		missionTitle: mission.title,
		status: "orchestrator_action_required",
		createdAt: nowIso(),
		block,
		instructions: [
			"Inspect block artifacts and transcript/stderr.",
			"Classify the failure as implementation defect, validator defect, procedural failure, environment issue, or planning issue.",
			"Repair artifacts/state when safe or revise the mission plan before resuming.",
			"Do not advance later features while this recovery packet is unresolved.",
		],
	};
	writeJson(jsonFile, packet);
	fs.writeFileSync(mdFile, [
		"# Mission Recovery Packet",
		"",
		`- Mission: ${mission.id} - ${mission.title}`,
		`- Status: orchestrator_action_required`,
		`- Block: ${describeBlock(block)}`,
		`- Run directory: ${block.runDir}`,
		"",
		"## Required orchestrator action",
		"1. Inspect block artifacts and transcript/stderr.",
		"2. Classify the failure.",
		"3. Repair artifacts/state when safe or revise the mission plan before resuming.",
		"4. Do not advance later features while this packet is unresolved.",
		"",
		"## Artifacts",
		...block.artifactPaths.map((artifact) => `- ${artifact}`),
		"",
	].join("\n"));
	return [jsonFile, mdFile];
}

function persistMissionBlock(dir: string, mission: MissionState, block: MissionBlockSummary, reasonCategory: BlockReasonCategory): void {
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

function formatMissionBlockMessage(block: MissionBlockSummary): string {
	const failedItem = block.kind === "worker"
		? `Feature ${block.featureId} - ${block.featureTitle}`
		: `Milestone ${block.milestoneId} - ${block.milestoneTitle}`;
	return [
		"[MISSION BLOCKED - RECOVERY CONTEXT]",
		block.reasonCategory === "no_runnable_pending_work"
			? "Mission execution stopped because pending work remains but no feature is currently runnable. Continue recovery in this main chat as the mission orchestrator; do not treat the mission as dead."
			: "A mission child agent blocked execution. Continue recovery in this main chat as the mission orchestrator; do not treat the mission as dead.",
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
		block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : block.kind === "user-testing-validator" ? "1. Read user-testing-report.json and user-testing-report.md if present." : "1. Read validation-report.json and validation-report.md if present.",
		"2. Inspect transcript.jsonl and stderr.txt in the run directory for the child-agent failure mode.",
		"3. Check `git status --short` and review any relevant diffs/commits mentioned by the artifacts.",
		"4. Decide whether this is an implementation defect, validation defect, planning issue, environmental/tooling issue, or procedural failure; revise/resume the mission only after the recovery path is clear.",
	].filter((line): line is string => Boolean(line)).join("\n");
}

function emitMissionBlockMessage(pi: ExtensionAPI, block: MissionBlockSummary): void {
	// Blocking a mission is an artifact/state transition, not permission to start a
	// nested assistant turn. Triggering a follow-up turn from inside a running tool
	// call or Mission Control action can collide with the active child execution and
	// interactive custom UI. Surface the recovery context as a display-only custom
	// message; the user can then decide when to continue recovery in chat.
	pi.sendMessage({
		customType: "missions-block-context",
		display: true,
		content: formatMissionBlockMessage(block),
		details: block,
	}, { triggerTurn: false, deliverAs: "followUp" });
}

function summarizeMission(mission: MissionState): string {
	const features = missionFeatureList(mission);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	const run = currentOrLastRunContext(mission);
	const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
	const lifecycleEvaluation = evaluateMissionLifecycleTransition(mission, lifecycle);
	const block = latestBlockFromArtifacts(mission);
	return [
		`Mission: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Progress: ${done}/${features.length} features`,
		`Dir: ${missionDir(mission.cwd, mission.id)}`,
		`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`,
		`Lifecycle evaluation: ${lifecycleEvaluation}`,
		run ? `${run.label}: ${run.runId}` : "Current/last run: none recorded",
		run ? `Run item: ${run.kind} ${run.itemId} — ${run.itemTitle}` : undefined,
		run ? `Run artifacts: ${run.runDir}` : undefined,
		block ? `Blocked reason: ${describeBlock(block)}` : undefined,
		block?.artifactPaths.length ? `Block artifacts: ${block.artifactPaths.join(", ")}` : undefined,
		`Next suggested action: ${nextSuggestedAction(mission, lifecycle, run, block)}`,
		"",
		...missionMilestones(mission).flatMap((m) => [
			`${mark(m.status)} ${m.id}: ${m.title}${m.validationRunId ? ` [validator ${m.validationRunId}]` : ""}`,
			...m.features.map((f) => `  ${mark(f.status)} ${f.id}: ${f.title}${f.runId ? ` [run ${f.runId}]` : ""}${f.reviewerRunIds?.length ? ` [reviewers ${f.reviewerRunIds.join(",")}]` : ""}${f.reviewerPending ? " [awaiting reviewers]" : ""}${f.userTestingPending ? " [awaiting user-testing]" : ""}${f.commit ? ` (${f.commit})` : ""}`),
		]),
	].filter((line): line is string => line !== undefined).join("\n");
}

function boundedExcerpt(text: string, maxChars = 700): string {
	const normalized = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
	if (normalized.length <= maxChars) return normalized || "(no objective text provided)";
	return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function validationSummary(validationContractJson: unknown): string {
	const maybeAssertions = (validationContractJson as { assertions?: unknown } | undefined)?.assertions;
	if (!Array.isArray(maybeAssertions)) return "Validation: no assertions array found.";
	const categories = new Map<string, number>();
	for (const assertion of maybeAssertions) {
		const category = typeof (assertion as { category?: unknown })?.category === "string" ? (assertion as { category: string }).category : "uncategorized";
		categories.set(category, (categories.get(category) ?? 0) + 1);
	}
	const categoryText = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `${category}: ${count}`).join(", ");
	return `Validation: ${maybeAssertions.length} assertion${maybeAssertions.length === 1 ? "" : "s"}${categoryText ? ` (${categoryText})` : ""}.`;
}

function planOutline(mission: MissionState, maxFeatures = 32): string[] {
	const features = missionFeatureList(mission);
	if (features.length === 0) return ["(no features provided)"];
	const lines = features.slice(0, maxFeatures).map((feature) => `${mark(feature.status)} ${feature.id}: ${feature.title}`);
	if (features.length > maxFeatures) lines.push(`… ${features.length - maxFeatures} more feature${features.length - maxFeatures === 1 ? "" : "s"}`);
	return lines;
}

function persistedPlanSummary(mission: MissionState, dir: string, objectiveMd: string, validationContractJson: unknown, existingMission: boolean): string {
	const action = existingMission ? "revised" : "written";
	const nextAction = mission.status === "planning"
		? "\n\nNext: continue refining, then persist a runnable plan when it is ready."
		: mission.status === "planned"
			? `\n\nNext: review the saved plan, then run /missions run ${mission.id} or use mission_start_execution to confirm and start implementation.`
			: "";
	return [
		`Mission plan ${action}: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Artifact directory: ${dir}`,
		"",
		"Objective excerpt:",
		boundedExcerpt(objectiveMd),
		"",
		"Features:",
		...planOutline(mission),
		"",
		validationSummary(validationContractJson),
	].join("\n") + nextAction;
}

function missionListText(cwd: string): string {
	const missions = listMissions(cwd);
	return missions.length ? missions.map((m) => `${m.id}  ${m.status}${isMissionCleared(cwd, m.id) ? " (cleared)" : ""}  ${m.title}`).join("\n") : "No missions found.";
}

function visibleMissions(cwd: string): MissionState[] {
	return listMissions(cwd).filter((mission) => !isMissionCleared(cwd, mission.id));
}

function resolveMission(cwd: string, id?: string, state?: MissionOrchestratorSessionState): MissionState | undefined {
	return id ? loadMission(cwd, id) : activeMissionFromState(cwd, state) ?? latestMission(cwd);
}

function clipLine(line: string, width: number): string {
	// Leave a one-column guard for terminal/wcwidth disagreements around emoji and
	// ellipsis glyphs. Mission Control is embedded directly in the main TUI render;
	// a single over-wide custom line crashes the whole pi process.
	const limit = Math.max(1, width - 1);
	return truncateToWidth(line, limit);
}

function padLineToWidth(line: string, width: number): string {
	const clipped = clipLine(line, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function exactClipLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width));
}

function exactPadLineToWidth(line: string, width: number): string {
	const clipped = exactClipLine(line, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function missionFeatureCounts(mission: MissionState): { done: number; total: number; running: number; failed: number; pending: number } {
	const features = missionFeatureList(mission);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	const running = features.filter((f) => f.status === "running").length;
	const failed = features.filter((f) => f.status === "failed").length;
	const pending = features.filter((f) => f.status === "pending").length;
	return { done, total: features.length, running, failed, pending };
}

function progressText(mission: MissionState): string {
	const counts = missionFeatureCounts(mission);
	return `${counts.done}/${counts.total}`;
}

function percentText(done: number, total: number): string {
	return total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

function progressBar(done: number, total: number, width: number): string {
	const safeWidth = Math.max(8, width);
	const filled = total > 0 ? Math.round((done / total) * safeWidth) : 0;
	return `${"█".repeat(Math.max(0, Math.min(safeWidth, filled)))}${"░".repeat(Math.max(0, safeWidth - filled))}`;
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

interface MissionControlEvent {
	ts?: string;
	type: string;
	data?: unknown;
}

interface MissionControlEventWindow {
	events: MissionControlEvent[];
	parsedInTail: number;
	malformedInTail: number;
	truncated: boolean;
	maxEvents: number;
}

type ChildOutputMode = "summary" | "raw" | "stderr";

interface MissionControlActivityViewModel {
	headline: string;
	rows: string[];
	events: MissionControlEvent[];
	hidden: number;
}

type MissionControlSelection =
	| { kind: "mission"; mission: MissionState }
	| { kind: "block"; mission: MissionState; block: MissionBlockMetadata }
	| { kind: "milestone"; mission: MissionState; milestone: MissionMilestone }
	| { kind: "feature"; mission: MissionState; milestone: MissionMilestone; feature: MissionFeature };

function readTailText(file: string, maxBytes: number): { text: string; truncated: boolean } {
	const stat = fs.statSync(file);
	const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes));
	const start = Math.max(0, stat.size - bytesToRead);
	const buffer = Buffer.alloc(bytesToRead);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buffer, 0, bytesToRead, start);
	} finally {
		fs.closeSync(fd);
	}
	let text = buffer.toString("utf8");
	if (start > 0) {
		const firstNewline = text.indexOf("\n");
		text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
	}
	return { text, truncated: start > 0 };
}

function readMissionEventWindow(mission: MissionState, maxEvents = 8, maxBytes = 64 * 1024): MissionControlEventWindow {
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return { events: [], parsedInTail: 0, malformedInTail: 0, truncated: false, maxEvents };
	const tail = readTailText(logFile, maxBytes);
	const events: MissionControlEvent[] = [];
	let malformedInTail = 0;
	for (const line of tail.text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { ts?: unknown; type?: unknown; data?: unknown };
			if (typeof parsed.type === "string") events.push({ ts: typeof parsed.ts === "string" ? parsed.ts : undefined, type: parsed.type, data: parsed.data });
			else malformedInTail += 1;
		} catch {
			// Ignore malformed historical log entries; Mission Control is best-effort and must keep rendering.
			malformedInTail += 1;
		}
	}
	return { events: events.slice(-maxEvents), parsedInTail: events.length, malformedInTail, truncated: tail.truncated, maxEvents };
}

function relativeEventTime(ts: string | undefined, now = Date.now()): string {
	if (!ts) return "time ?";
	const time = Date.parse(ts);
	if (!Number.isFinite(time)) return "time ?";
	const diffSeconds = Math.max(0, Math.round((now - time) / 1000));
	if (diffSeconds < 60) return `${diffSeconds}s ago`;
	const diffMinutes = Math.round(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 48) return `${diffHours}h ago`;
	const diffDays = Math.round(diffHours / 24);
	if (diffDays < 14) return `${diffDays}d ago`;
	return ts.replace(/^\d{4}-/, "").replace(/T/, " ").replace(/\.\d{3}Z$/, "Z");
}

function eventIcon(event: MissionControlEvent): string {
	const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : undefined;
	const exitCode = typeof data?.exitCode === "number" ? data.exitCode : undefined;
	if (event.type.includes("block") || event.type.includes("failed") || event.type.includes("error") || (typeof exitCode === "number" && exitCode !== 0)) return "✗";
	if (event.type.includes("finished") || event.type.includes("complete")) return "✓";
	if (event.type.includes("started")) return "▶";
	if (event.type.includes("plan") || event.type.includes("written")) return "◆";
	return "•";
}

function eventLabel(type: string): string {
	const labels: Record<string, string> = {
		interactive_plan_written: "plan written",
		mission_execution_started: "execution started",
		worker_started: "worker started",
		worker_finished: "worker finished",
		worker_failed: "worker failed",
		validator_started: "validator started",
		validator_finished: "validator finished",
		mission_block_recorded: "block recorded",
		mission_pause_requested: "pause requested",
		mission_paused_after_current: "paused after current",
		mission_resume_requested: "resume requested",
		mission_auto_resume_after_plan_revision: "auto resume requested",
		mission_cleared: "mission cleared",
		mission_control_action_started: "control action started",
		mission_control_action_finished: "control action finished",
		mission_control_action_canceled: "control action canceled",
		mission_control_action_failed: "control action failed",
		handoff_parse_error: "handoff parse error",
		validation_parse_error: "validation parse error",
		user_testing_started: "user testing started",
		user_testing_finished: "user testing finished",
		user_testing_parse_error: "user testing parse error",
		mission_complete: "mission complete",
	};
	return labels[type] ?? type.replace(/_/g, " ");
}

function shortRunId(runId: unknown): string | undefined {
	if (typeof runId !== "string" || !runId) return undefined;
	const parts = runId.split("-");
	return parts.length >= 3 ? `${parts[1]}-${parts.slice(2).join("-")}` : runId;
}

function eventDataSummary(event: MissionControlEvent): string {
	if (!event.data || typeof event.data !== "object") return "";
	const record = event.data as Record<string, unknown>;
	const pieces: string[] = [];
	const featureId = typeof record.featureId === "string" ? record.featureId : undefined;
	const milestoneId = typeof record.milestoneId === "string" ? record.milestoneId : undefined;
	const runId = shortRunId(record.runId);
	const status = typeof record.status === "string" ? record.status : undefined;
	const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
	const kind = typeof record.kind === "string" ? record.kind : undefined;
	const failedItemId = typeof record.failedItemId === "string" ? record.failedItemId : undefined;
	const reason = typeof record.reasonCategory === "string" ? record.reasonCategory.replace(/_/g, " ") : undefined;
	const actionId = typeof record.actionId === "string" ? record.actionId.replace(/-/g, " ") : undefined;
	const source = typeof record.source === "string" ? record.source.replace(/_/g, " ") : undefined;
	const completedUnit = typeof record.completedUnit === "string" ? record.completedUnit : undefined;
	const ok = typeof record.ok === "boolean" ? record.ok : undefined;
	const tool = typeof record.toolName === "string" ? record.toolName : typeof record.name === "string" ? record.name : undefined;
	const textSummary = [record.summary, record.text, record.message, record.error]
		.find((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (event.type === "mission_block_recorded") {
		if (kind || failedItemId) pieces.push([kind, failedItemId].filter(Boolean).join(" "));
		if (reason) pieces.push(reason);
	} else {
		if (featureId) pieces.push(featureId);
		else if (milestoneId) pieces.push(milestoneId);
		if (actionId) pieces.push(actionId);
		if (completedUnit) pieces.push(`after ${completedUnit}`);
		if (source) pieces.push(source);
		if (tool) pieces.push(`tool ${tool}`);
		if (status) pieces.push(status);
		if (typeof ok === "boolean") pieces.push(ok ? "ok" : "not ok");
		if (typeof exitCode === "number") pieces.push(`exit ${exitCode}`);
		if (textSummary) pieces.push(compactSnippetText(textSummary, 90));
	}
	if (runId) pieces.push(`run ${runId}`);
	return pieces.length ? ` — ${pieces.join(" · ")}` : "";
}

function formatMissionEventLine(event: MissionControlEvent, now = Date.now()): string {
	return `${relativeEventTime(event.ts, now).padStart(7)} ${eventIcon(event)} ${eventLabel(event.type)}${eventDataSummary(event)}`;
}

function missionActivityViewModel(mission: MissionState, selectedIndexFromEnd = 0): MissionControlActivityViewModel {
	const window = readMissionEventWindow(mission);
	const prefix = window.truncated ? "Recent tail" : "Recent log";
	const hidden = Math.max(0, window.parsedInTail - window.events.length);
	const headline = `${prefix}: showing ${window.events.length}/${window.parsedInTail} parsed event${window.parsedInTail === 1 ? "" : "s"}${hidden ? ` (${hidden} older in tail)` : ""}${window.malformedInTail ? ` · skipped ${window.malformedInTail} malformed` : ""}`;
	if (window.events.length === 0) return { headline, rows: [], events: [], hidden };
	const now = Date.now();
	const selected = Math.max(0, Math.min(window.events.length - 1, selectedIndexFromEnd));
	const rows = window.events.map((event, index) => {
		const marker = index === window.events.length - 1 - selected ? "▸" : " ";
		return `${marker} ${formatMissionEventLine(event, now)}`;
	});
	return { headline, rows, events: window.events, hidden };
}

function runArtifactSummaryLines(run: MissionRunContext): string[] {
	const jsonFile = path.join(run.runDir, run.kind === "worker" ? "handoff.json" : run.kind === "user-testing-validator" ? "user-testing-report.json" : "validation-report.json");
	const mdFile = path.join(run.runDir, run.kind === "worker" ? "handoff.md" : run.kind === "user-testing-validator" ? "user-testing-report.md" : "validation-report.md");
	const transcriptFile = path.join(run.runDir, "transcript.jsonl");
	const stderrFile = path.join(run.runDir, "stderr.txt");
	const childSession = childSessionRecordForRun(run);
	const lines = [
		`${path.basename(jsonFile)}: ${fs.existsSync(jsonFile) ? jsonFile : "not available"}`,
		`${path.basename(mdFile)}: ${fs.existsSync(mdFile) ? mdFile : "not available"}`,
	];
	if (childSession) {
		lines.push(`Child session: ${childSession.role} ${childSession.featureId ?? childSession.milestoneId} attempt ${childSession.attempt} · ${childSession.status}`);
		if (childSession.sessionId) lines.push(`Child session id: ${childSession.sessionId}`);
		if (childSession.sessionPath) lines.push(`Child session path: ${childSession.sessionPath}`);
		lines.push(`Child transcript: ${childSession.transcriptPath}`);
	}
	if (fs.existsSync(transcriptFile)) lines.push(`transcript: ${transcriptFile}`);
	if (fs.existsSync(stderrFile)) lines.push(`stderr: ${stderrFile}`);
	if (fs.existsSync(jsonFile)) {
		try {
			const artifact = readJson<Record<string, unknown>>(jsonFile);
			const validation = validateMissionArtifact(run.kind === "worker" ? "worker-handoff" : run.kind === "user-testing-validator" ? "user-testing-report" : "scrutiny-validation-report", artifact);
			const status = typeof artifact.status === "string" ? artifact.status : undefined;
			const commit = typeof artifact.commit === "string" ? artifact.commit : undefined;
			const summary = typeof artifact.summary === "string" ? artifact.summary : undefined;
			if (status || commit) lines.push(`Artifact status: ${[status, commit ? `commit ${commit}` : undefined].filter(Boolean).join(" · ")}`);
			if (summary) lines.push(`Artifact summary: ${summary}`);
			if (!validation.ok) lines.push(artifactValidationErrorSummary(run.kind === "worker" ? "worker-handoff" : run.kind === "user-testing-validator" ? "user-testing-report" : "scrutiny-validation-report", validation.issues));
		} catch {
			lines.push(`Artifact summary: ${jsonFile} could not be parsed`);
		}
	}
	return lines;
}

function missionSkillPath(mission: MissionState, role: "worker" | "validator"): string {
	return path.join(missionDir(mission.cwd, mission.id), "skills", role === "worker" ? "worker" : "validator-scrutiny", "SKILL.md");
}

function validationContractAssertions(mission: MissionState): ValidationContractAssertion[] {
	const file = path.join(missionDir(mission.cwd, mission.id), "plan", "validation-contract.json");
	if (!fs.existsSync(file)) return [];
	try {
		const parsed = readJson<{ assertions?: unknown }>(file);
		if (!Array.isArray(parsed.assertions)) return [];
		return parsed.assertions.filter((value): value is ValidationContractAssertion => Boolean(value) && typeof value === "object");
	} catch {
		return [];
	}
}

function featureDependencyLines(mission: MissionState, feature: MissionFeature): string[] {
	if (!feature.dependencies?.length) return ["Preconditions: no feature dependencies recorded"];
	const features = new Map(missionMilestones(mission).flatMap((milestone) => milestone.features.map((item) => [item.id, item] as const)));
	return [`Dependencies: ${feature.dependencies.map((id) => {
		const dependency = features.get(id);
		return dependency ? `${id} ${mark(dependency.status)} ${dependency.status}` : `${id} ? unknown`;
	}).join(", ")}`];
}

function validatorPreconditionLines(milestone: MissionMilestone): string[] {
	const incomplete = milestone.features.filter((feature) => feature.status !== "complete" && feature.status !== "skipped");
	if (incomplete.length === 0) return ["Preconditions: all milestone features complete/skipped"];
	return [`Preconditions: waiting on ${incomplete.map((feature) => `${feature.id} ${feature.status}`).join(", ")}`];
}

function verificationHintLines(mission: MissionState, categories: string[]): string[] {
	const hints = validationContractAssertions(mission)
		.filter((assertion) => assertion.category && categories.includes(assertion.category))
		.slice(0, 3)
		.map((assertion) => `Verify ${assertion.id ?? assertion.category}: ${assertion.verification ?? assertion.assertion ?? "see validation contract"}`);
	return hints.length ? hints : ["Verify: see plan/validation-contract.json"];
}

function currentWorkArtifactLines(run?: MissionRunContext): string[] {
	if (!run) return ["Artifacts: no run directory yet"];
	return [`Run id: ${run.runId}`, `Run dir: ${run.runDir}`, ...runArtifactSummaryLines(run)];
}

function featureRunContext(mission: MissionState, feature: MissionFeature): MissionRunContext | undefined {
	if (!feature.runId) return undefined;
	return {
		label: `${feature.status === "running" ? "Current" : "Feature"} worker run`,
		runId: feature.runId,
		runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId),
		kind: "worker",
		itemId: feature.id,
		itemTitle: feature.title,
		status: feature.status,
	};
}

function milestoneValidationRunContext(mission: MissionState, milestone: MissionMilestone): MissionRunContext | undefined {
	if (!milestone.validationRunId) return undefined;
	return {
		label: `${milestone.status === "running" ? "Current" : "Milestone"} validator run`,
		runId: milestone.validationRunId,
		runDir: path.join(missionDir(mission.cwd, mission.id), "runs", milestone.validationRunId),
		kind: "validator",
		itemId: milestone.id,
		itemTitle: milestone.title,
		status: milestone.status,
	};
}

function currentSelection(mission: MissionState): MissionControlSelection {
	const currentMilestone = missionMilestones(mission).find((m) => m.id === mission.currentMilestoneId) ?? missionMilestones(mission).find((m) => m.status === "running") ?? missionMilestones(mission)[0];
	if (!currentMilestone) return { kind: "mission", mission };
	const currentFeature = currentMilestone.features.find((f) => f.id === mission.currentFeatureId) ?? currentMilestone.features.find((f) => f.status === "running");
	if (currentFeature) return { kind: "feature", mission, milestone: currentMilestone, feature: currentFeature };
	return { kind: "milestone", mission, milestone: currentMilestone };
}

function blockSelectionId(block: MissionBlockMetadata): string {
	return `block:${block.runId}:${block.failedItemId}`;
}

function missionControlSelectableItems(mission: MissionState, block = latestBlockFromArtifacts(mission)): MissionControlSelection[] {
	const items: MissionControlSelection[] = [{ kind: "mission", mission }];
	if (block) items.push({ kind: "block", mission, block });
	for (const milestone of missionMilestones(mission)) {
		items.push({ kind: "milestone", mission, milestone });
		for (const feature of milestone.features) items.push({ kind: "feature", mission, milestone, feature });
	}
	return items;
}

function selectionId(selection: MissionControlSelection): string {
	if (selection.kind === "block") return blockSelectionId(selection.block);
	if (selection.kind === "feature") return selection.feature.id;
	if (selection.kind === "milestone") return selection.milestone.id;
	return selection.mission.id;
}

function missionControlSelectionById(mission: MissionState, selectedId?: string, block = latestBlockFromArtifacts(mission)): MissionControlSelection {
	if (selectedId) {
		const match = missionControlSelectableItems(mission, block).find((item) => selectionId(item) === selectedId);
		if (match) return match;
	}
	return currentSelection(mission);
}

function moveMissionControlSelection(mission: MissionState, selectedId: string | undefined, delta: number): string {
	const items = missionControlSelectableItems(mission);
	if (items.length === 0) return mission.id;
	const fallbackId = selectionId(currentSelection(mission));
	const currentIndex = Math.max(0, items.findIndex((item) => selectionId(item) === (selectedId ?? fallbackId)));
	const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta));
	return selectionId(items[nextIndex]);
}

function missionControlHeader(mission: MissionState, width: number): string[] {
	const run = currentOrLastRunContext(mission);
	const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
	const counts = missionFeatureCounts(mission);
	const barWidth = Math.max(8, Math.min(28, width - 44));
	const runText = run ? `${run.label} ${run.runId} (${run.kind} ${run.itemId})` : "no active run";
	const statusStrip = ` STATUS ${mission.status.toUpperCase()} · lifecycle ${lifecycle.state} · updated ${mission.updatedAt} `;
	const titleStrip = ` MISSION CONTROL · ${mission.title} (${mission.id}) `;
	const progressStrip = ` PROGRESS ${progressText(mission)} ${percentText(counts.done, counts.total)} · ${counts.running} running · ${counts.pending} pending · ${counts.failed} failed `;
	const line = (content: string): string => {
		const innerWidth = Math.max(1, width - 2);
		return exactClipLine(`│${exactPadLineToWidth(content, innerWidth)}│`, width);
	};
	return [
		exactClipLine(`┌${"═".repeat(Math.max(1, width - 2))}┐`, width),
		line(titleStrip),
		line(statusStrip),
		line(`${progressStrip}[${progressBar(counts.done, counts.total, barWidth)}]`),
		line(` RUN ${runText} `),
		exactClipLine(`└${"═".repeat(Math.max(1, width - 2))}┘`, width),
	];
}

function missionControlPlaneLines(mission: MissionState): string[] {
	const lock = readRunnerLock(mission.cwd, mission.id);
	const orchestrator = readOrchestratorSessionRecord(mission.cwd, mission.id);
	const now = Date.now();
	const lockLine = (() => {
		if (!lock) return "Runner lock: none";
		const heartbeat = relativeEventTime(lock.heartbeatAt, now);
		const owner = `pid ${lock.ownerPid} (${lock.ownerSessionMarker})`;
		const lockState = lock.status === "active" && !lockHeartbeatExpired(lock) ? "active" : lock.status;
		return `Runner lock: ${lockState} · ${owner} · heartbeat ${heartbeat}`;
	})();
	const currentFeatureId = mission.currentFeatureId;
	const registry = readChildSessionRegistry(mission.cwd, mission.id);
	const workerAttempts = currentFeatureId ? registry.records.filter((record) => record.role === "worker" && record.featureId === currentFeatureId).length : 0;
	const validatorAttempts = currentFeatureId ? registry.records.filter((record) => record.role === "validator" && record.featureId === currentFeatureId).length : 0;
	const userTestingAttempts = currentFeatureId ? registry.records.filter((record) => record.role === "user-testing-validator" && record.featureId === currentFeatureId).length : 0;
	return [
		lockLine,
		`Current feature attempt: ${currentFeatureId ? `${currentFeatureId} #${Math.max(1, workerAttempts)}` : "none"}`,
		`Current validation attempt: ${currentFeatureId ? `${currentFeatureId} #${Math.max(0, validatorAttempts)}` : "none"}`,
		`Current user-testing attempt: ${currentFeatureId ? `${currentFeatureId} #${Math.max(0, userTestingAttempts)}` : "none"}`,
		`Official orchestrator session: ${orchestrator?.sessionPath ? orchestrator.sessionPath : "not recorded"}`,
		"Controls route via deterministic runner command API (p/s/x).",
	];
}

function missionTreeLines(mission: MissionState, selection: MissionControlSelection, block?: MissionBlockMetadata): string[] {
	const selectedId = selectionId(selection);
	const lines = ["Mission tree", `${selectedId === mission.id ? ">" : " "} ${mark(mission.status)} ${mission.id}`];
	if (block) lines.push(`${selectedId === blockSelectionId(block) ? ">" : " "} ! Block ${block.reasonCategory} on ${block.failedItemId}`);
	for (const milestone of missionMilestones(mission)) {
		lines.push(`${selectedId === milestone.id ? ">" : " "} ${mark(milestone.status)} ${milestone.id} ${milestone.title}`);
		for (const feature of milestone.features) lines.push(`${selectedId === feature.id ? ">" : " "}   ${mark(feature.status)} ${feature.id} ${feature.title}`);
	}
	return lines;
}

function blockInspectionLines(block: MissionBlockMetadata): string[] {
	const artifactLines = block.artifactPaths.length > 0
		? block.artifactPaths.map((artifact) => `Artifact: ${artifact}`)
		: ["Artifact: none recorded; inspect the run directory directly."];
	return [
		"Block details",
		`Reason category: ${block.reasonCategory}`,
		`Failed item: ${block.kind} ${block.failedItemId} — ${block.failedItemTitle}`,
		`Run id: ${block.runId}`,
		`Run dir: ${block.runDir}`,
		`Exit code: ${block.exitCode}`,
		...(block.status ? [`Reported status: ${block.status}`] : []),
		...artifactLines,
		"Suggested inspection steps:",
		block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : block.kind === "user-testing-validator" ? "1. Read user-testing-report.json and user-testing-report.md if present." : "1. Read validation-report.json and validation-report.md if present.",
		"2. Inspect transcript.jsonl and stderr.txt in the run directory if artifacts are missing or incomplete.",
		"3. Decide whether to revise the mission plan, fix the implementation, or resume execution.",
	];
}

function missionDetailsLines(selection: MissionControlSelection, run?: MissionRunContext, block?: MissionBlockMetadata): string[] {
	const mission = selection.mission;
	const lines = ["Details"];
	if (selection.kind === "mission") {
		lines.push(`Mission: ${mission.title}`, `ID: ${mission.id}`, `Status: ${mission.status}`, `Created: ${mission.createdAt}`, `Updated: ${mission.updatedAt}`);
	} else if (selection.kind === "block") {
		lines.push(...blockInspectionLines(selection.block));
	} else if (selection.kind === "milestone") {
		lines.push(`Milestone: ${selection.milestone.id} — ${selection.milestone.title}`, `Status: ${selection.milestone.status}`);
		if (selection.milestone.objective) lines.push(`Objective: ${selection.milestone.objective}`);
		if (selection.milestone.validation) lines.push(`Validation: ${selection.milestone.validation}`);
		if (selection.milestone.validationRunId) lines.push(`Validation run: ${selection.milestone.validationRunId}`);
	} else {
		lines.push(`Feature: ${selection.feature.id} — ${selection.feature.title}`, `Status: ${selection.feature.status}`);
		if (selection.feature.dependencies?.length) lines.push(`Dependencies: ${selection.feature.dependencies.join(", ")}`);
		if (selection.feature.runId) lines.push(`Run: ${selection.feature.runId}`);
		if (selection.feature.validationRunId) lines.push(`Validation run: ${selection.feature.validationRunId}`);
		if (selection.feature.userTestingRunId) lines.push(`User-testing run: ${selection.feature.userTestingRunId}`);
		if (selection.feature.reviewerRunIds?.length) lines.push(`Reviewer runs: ${selection.feature.reviewerRunIds.join(", ")}`);
		lines.push(`Reviewer fanout required: ${isFeatureReviewRequired(selection.feature) ? "yes" : "no"}`);
		lines.push(`User testing required: ${isFeatureUserTestingRequired(selection.feature) ? "yes" : "no"}`);
		if (selection.feature.commit) lines.push(`Commit: ${selection.feature.commit}`);
		lines.push(`Description: ${selection.feature.description}`);
	}
	if (run) lines.push("", "Run context", `${run.label}: ${run.runId}`, `Item: ${run.kind} ${run.itemId} — ${run.itemTitle}`, `Artifacts: ${run.runDir}`, ...runArtifactSummaryLines(run));
	if (block && selection.kind !== "block") lines.push("", "Block context", ...blockInspectionLines(block));
	return lines;
}

function progressLogLines(mission: MissionState, selectedIndexFromEnd = 0): string[] {
	const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
	const model = missionActivityViewModel(mission, selectedIndexFromEnd);
	if (model.events.length === 0) {
		const base = model.headline.includes("malformed") ? model.headline : "(no events recorded)";
		return [`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`, base];
	}
	return [`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`, model.headline, ...model.rows];
}

function conciseArtifactSummary(run?: MissionRunContext): string {
	if (!run) return "Artifacts: none yet";
	const summary = runArtifactSummaryLines(run).find((line) => line.startsWith("Artifact status:") || line.startsWith("Artifact summary:"));
	return summary ? `Artifacts: ${summary.replace(/^Artifact (status|summary):\s*/, "")}` : `Artifacts: run ${run.runId} recorded`;
}

function currentItemLines(selection: MissionControlSelection, run?: MissionRunContext, block?: MissionBlockMetadata, activityEvent?: MissionControlEvent): string[] {
	const lifecycle = classifyMissionRunLifecycle(selection.mission.cwd, selection.mission);
	const nextAction = `Next action: ${nextSuggestedAction(selection.mission, lifecycle, run, block)}`;
	if (activityEvent) {
		return [
			`Activity event: ${eventLabel(activityEvent.type)}`,
			`When: ${relativeEventTime(activityEvent.ts)}${activityEvent.ts ? ` (${activityEvent.ts})` : ""}`,
			`Severity: ${eventIcon(activityEvent)}`,
			`Summary: ${eventLabel(activityEvent.type)}${eventDataSummary(activityEvent)}`,
			...(activityEvent.data !== undefined ? ["Data:", compactSnippetText(JSON.stringify(activityEvent.data), 320)] : ["Data: none"]),
		];
	}
	if (selection.kind === "mission") {
		const counts = missionFeatureCounts(selection.mission);
		return [
			`${mark(selection.mission.status)} Mission ${selection.mission.id}`,
			`Status: ${selection.mission.status} · lifecycle ${lifecycle.state}`,
			`Progress: ${progressText(selection.mission)} ${percentText(counts.done, counts.total)}`,
			`Current feature: ${selection.mission.currentFeatureId ?? "not set"}`,
			nextAction,
			conciseArtifactSummary(run),
		];
	}
	if (selection.kind === "block") return blockInspectionLines(selection.block);
	if (selection.kind === "milestone") {
		const done = selection.milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
		const validatorRun = run?.kind === "validator" && run.itemId === selection.milestone.id ? run : milestoneValidationRunContext(selection.mission, selection.milestone);
		return [
			`${mark(selection.milestone.status)} Milestone ${selection.milestone.id}`,
			`Status: ${selection.milestone.status} · features ${done}/${selection.milestone.features.length}`,
			...(selection.milestone.validationRunId ? [`Attempts: validator run ${selection.milestone.validationRunId}`] : ["Attempts: validator not started"]),
			...(selection.milestone.validation ? [`Expected: ${selection.milestone.validation}`] : []),
			nextAction,
			conciseArtifactSummary(validatorRun),
		];
	}
	const featureRun = run?.kind === "worker" && run.itemId === selection.feature.id ? run : featureRunContext(selection.mission, selection.feature);
	const registry = readChildSessionRegistry(selection.mission.cwd, selection.mission.id);
	const workerAttempts = registry.records.filter((record) => record.role === "worker" && record.featureId === selection.feature.id).length;
	const validatorAttempts = registry.records.filter((record) => record.role === "validator" && record.featureId === selection.feature.id).length;
	const userTestingAttempts = registry.records.filter((record) => record.role === "user-testing-validator" && record.featureId === selection.feature.id).length;
	const lines = [
		`${mark(selection.feature.status)} Feature ${selection.feature.id}`,
		`Status: ${selection.feature.status}`,
		`Attempts: worker ${workerAttempts} · validator ${validatorAttempts} · user-testing ${userTestingAttempts}`,
		...(selection.feature.commit ? [`Commit: ${selection.feature.commit}`] : ["Commit: not recorded"]),
		conciseArtifactSummary(featureRun),
		nextAction,
		...(selection.feature.description ? [`Summary: ${selection.feature.description}`] : []),
	];
	if (block) lines.push(`Block: ${block.reasonCategory} on ${block.failedItemId}`);
	return lines;
}

function groupedFeatureLines(mission: MissionState, selection: MissionControlSelection, block?: MissionBlockMetadata): string[] {
	const selectedId = selectionId(selection);
	const row = (id: string, status: string, label: string, indent = ""): string => {
		const selected = selectedId === id;
		return `${selected ? "▸" : " "} ${indent}${mark(status)} ${label}${selected ? " ◂" : ""}`;
	};
	const lines = [row(mission.id, mission.status, mission.id)];
	if (block) lines.push(`${selectedId === blockSelectionId(block) ? "▸" : " "} ! Block ${block.reasonCategory} on ${block.failedItemId}${selectedId === blockSelectionId(block) ? " ◂" : ""}`);
	for (const milestone of missionMilestones(mission)) {
		const done = milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
		lines.push(row(milestone.id, milestone.status, `${milestone.id} ${milestone.title} (${done}/${milestone.features.length})`));
		for (const feature of milestone.features) lines.push(row(feature.id, feature.status, `${feature.id} ${feature.title}`, "  "));
	}
	return lines;
}

const CHILD_TRANSCRIPT_TAIL_BYTES = 16 * 1024;
const CHILD_STDERR_TAIL_BYTES = 8 * 1024;
const CHILD_OUTPUT_MAX_TRANSCRIPT_LINES = 8;
const CHILD_OUTPUT_MAX_STDERR_LINES = 4;
const CHILD_OUTPUT_MAX_PANEL_LINES = 14;

interface ChildTailReadResult {
	text: string;
	truncated: boolean;
	missing: boolean;
	error?: string;
}

function safeReadTailText(file: string, maxBytes: number): ChildTailReadResult {
	if (!fs.existsSync(file)) return { text: "", truncated: false, missing: true };
	try {
		return { ...readTailText(file, maxBytes), missing: false };
	} catch (error) {
		return { text: "", truncated: false, missing: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function compactSnippetText(value: string, maxChars = 220): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

function contentPartSnippet(part: unknown): string | undefined {
	if (!part || typeof part !== "object") return undefined;
	const record = part as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "content";
	if (typeof record.text === "string") return compactSnippetText(record.text);
	if (typeof record.message === "string") return compactSnippetText(record.message);
	if (typeof record.name === "string" && (type === "tool_use" || type === "tool_call")) return `tool ${record.name}`;
	if (type === "tool_result" || type === "tool_output") {
		if (typeof record.content === "string") return `tool result: ${compactSnippetText(record.content)}`;
		return "tool result";
	}
	if (typeof record.content === "string") return compactSnippetText(record.content);
	return undefined;
}

function messageSnippet(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (typeof record.content === "string") return compactSnippetText(record.content);
	if (Array.isArray(record.content)) {
		const snippets = record.content.map(contentPartSnippet).filter((snippet): snippet is string => Boolean(snippet));
		if (snippets.length > 0) return snippets.join(" | ");
	}
	return undefined;
}

function transcriptEventSnippet(event: Record<string, unknown>): string | undefined {
	const type = typeof event.type === "string" ? event.type : "event";
	const directText = [event.text, event.message, event.output, event.stdout].find((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (directText) return `${type}: ${compactSnippetText(directText)}`;
	const nestedMessage = messageSnippet(event.message);
	if (nestedMessage) return `${type}: ${nestedMessage}`;
	const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : undefined;
	if (typeof delta?.text === "string" && delta.text.trim()) return `${type}: ${compactSnippetText(delta.text)}`;
	const contentDelta = event.content_delta && typeof event.content_delta === "object" ? event.content_delta as Record<string, unknown> : undefined;
	if (typeof contentDelta?.text === "string" && contentDelta.text.trim()) return `${type}: ${compactSnippetText(contentDelta.text)}`;
	if (typeof event.name === "string" && (type.includes("tool") || event.tool_use_id)) return `${type}: tool ${event.name}`;
	return undefined;
}

function transcriptStreamLine(event: Record<string, unknown>, fallback: string): string {
	const type = typeof event.type === "string" ? event.type : "event";
	const timestamp = typeof (event.message as { timestamp?: unknown } | undefined)?.timestamp === "number" ? new Date((event.message as { timestamp: number }).timestamp).toISOString().slice(11, 19) : "";
	const prefix = timestamp ? `${timestamp} ${type}` : type;
	const text = transcriptEventSnippet(event) ?? fallback;
	return `${prefix}: ${text.replace(/^${type}: /, "")}`;
}

function transcriptTailLines(file: string): string[] {
	const tail = safeReadTailText(file, CHILD_TRANSCRIPT_TAIL_BYTES);
	if (tail.missing) return ["transcript.jsonl: not available yet"];
	if (tail.error) return [`transcript.jsonl: could not read tail (${tail.error})`];
	const stream: string[] = [];
	let malformed = 0;
	for (const rawLine of tail.text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed && typeof parsed === "object") stream.push(transcriptStreamLine(parsed as Record<string, unknown>, line));
			else stream.push(`raw: ${line}`);
		} catch {
			malformed += 1;
			stream.push(`raw: ${line}`);
		}
	}
	const prefix = tail.truncated ? "transcript stream tail" : "transcript stream";
	const visible = stream.slice(-CHILD_OUTPUT_MAX_TRANSCRIPT_LINES);
	const hidden = Math.max(0, stream.length - visible.length);
	return [
		`${prefix}: ${stream.length} line${stream.length === 1 ? "" : "s"}${hidden ? ` · showing last ${visible.length}` : ""}${malformed ? ` · ${malformed} raw/malformed` : ""}`,
		...visible,
	];
}

function stderrTailLines(file: string): string[] {
	const tail = safeReadTailText(file, CHILD_STDERR_TAIL_BYTES);
	if (tail.missing) return [];
	if (tail.error) return [`stderr.txt: could not read tail (${tail.error})`];
	const stderrLines = tail.text.split("\n").map((line) => compactSnippetText(line)).filter(Boolean).slice(-CHILD_OUTPUT_MAX_STDERR_LINES);
	if (stderrLines.length === 0) return [];
	return [`${tail.truncated ? "stderr tail" : "stderr"}:`, ...stderrLines.map((line) => `stderr: ${line}`)];
}

function childOutputSummaryLines(transcriptFile: string, stderrFile: string): string[] {
	return [...transcriptTailLines(transcriptFile), ...stderrTailLines(stderrFile)];
}

function childOutputRawLines(transcriptFile: string): string[] {
	const tail = safeReadTailText(transcriptFile, CHILD_TRANSCRIPT_TAIL_BYTES);
	if (tail.missing) return ["transcript.jsonl: not available yet"];
	if (tail.error) return [`transcript.jsonl: could not read tail (${tail.error})`];
	const rawLines = tail.text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-CHILD_OUTPUT_MAX_TRANSCRIPT_LINES);
	return [`${tail.truncated ? "transcript raw tail" : "transcript raw"}: showing ${rawLines.length} line${rawLines.length === 1 ? "" : "s"}`, ...rawLines.map((line) => `json: ${compactSnippetText(line, 260)}`)];
}

function childOutputLines(run: MissionRunContext | undefined, mode: ChildOutputMode): string[] {
	if (!run) {
		return [
			"Live stream: no active child run.",
			"Waiting for transcript.jsonl or stderr.txt artifacts.",
		];
	}
	const transcriptFile = path.join(run.runDir, "transcript.jsonl");
	const stderrFile = path.join(run.runDir, "stderr.txt");
	const modeLabel = mode === "summary" ? "summary" : mode === "raw" ? "raw transcript" : "stderr";
	const modeLines = mode === "summary"
		? childOutputSummaryLines(transcriptFile, stderrFile)
		: mode === "raw"
			? childOutputRawLines(transcriptFile)
			: (() => {
				const stderr = stderrTailLines(stderrFile);
				return stderr.length > 0 ? stderr : ["stderr.txt: no output yet"];
			})();
	const lines = [
		`Live stream: ${run.label} ${run.kind === "worker" ? "worker" : run.kind}`,
		`Run: ${run.runId}`,
		`Item: ${run.kind} ${run.itemId} — ${run.itemTitle}`,
		`Artifacts: ${run.runDir}`,
		`View mode: ${modeLabel} (o to toggle)`,
		"",
		...modeLines,
	];
	return limitLines(lines, CHILD_OUTPUT_MAX_PANEL_LINES, 120);
}

type MissionControlLayoutMode = "wide" | "medium" | "narrow" | "compact";

function missionControlLayoutMode(width: number): MissionControlLayoutMode {
	if (width >= 120) return "wide";
	if (width >= 90) return "medium";
	if (width >= 62) return "narrow";
	return "compact";
}

function limitLines(lines: string[], maxLines: number, width: number): string[] {
	if (lines.length <= maxLines) return lines.map((line) => exactClipLine(line, width));
	const hidden = lines.length - maxLines + 1;
	return [...lines.slice(0, Math.max(0, maxLines - 1)), `… ${hidden} more line${hidden === 1 ? "" : "s"}`].map((line) => exactClipLine(line, width));
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

function compactMissionControlHeader(mission: MissionState, width: number): string[] {
	const counts = missionFeatureCounts(mission);
	const run = currentOrLastRunContext(mission);
	const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
	const current = mission.currentFeatureId ?? mission.currentMilestoneId ?? "mission";
	return [
		clipLine(`MISSION ${mission.status}/${lifecycle.state} · ${progressText(mission)} ${percentText(counts.done, counts.total)}`, width),
		clipLine(`Current: ${current}${run ? ` · ${run.kind} ${run.runId}` : ""}`, width),
	];
}

function compactGroupedFeatureLines(mission: MissionState, selection: MissionControlSelection, block?: MissionBlockMetadata): string[] {
	const selectedId = selectionId(selection);
	const row = (id: string, status: string, label: string): string => `${selectedId === id ? "▸" : " "} ${mark(status)} ${label}${selectedId === id ? " ◂" : ""}`;
	const lines: string[] = [];
	if (block) lines.push(`${selectedId === blockSelectionId(block) ? "▸" : " "} ! ${block.failedItemId}: ${block.reasonCategory}${selectedId === blockSelectionId(block) ? " ◂" : ""}`);
	for (const milestone of missionMilestones(mission)) {
		const done = milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
		lines.push(row(milestone.id, milestone.status, `${milestone.id} (${done}/${milestone.features.length})`));
		for (const feature of milestone.features) lines.push(row(feature.id, feature.status, `${feature.id} ${feature.title}`));
	}
	return lines;
}

type MissionControlOverlayMode = "overview" | "detail";

interface MissionControlViewState {
	selectedMissionId?: string;
	mode: MissionControlOverlayMode;
	outputScrollOffset: number;
	showHelp: boolean;
}

function createMissionControlViewState(): MissionControlViewState {
	return { mode: "overview", outputScrollOffset: 0, showHelp: false };
}

const MISSION_CONTROL_POLL_MS = 1500;

function missionControlStatusIcon(status: Status): string {
	if (status === "blocked" || status === "failed") return "!";
	if (status === "running") return "▶";
	if (status === "paused") return "Ⅱ";
	if (status === "complete") return "✓";
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
	const lines: string[] = ["Mission Control", "Read-only overview", ""];
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
	const output = missionControlOutputLines(mission.detailOutput);
	const reserved = summary.length + 6 + (view.showHelp ? missionControlHelpLines().length + 1 : 0);
	const panelHeight = Math.max(5, (height ?? 30) - reserved);
	const rendered = limitedPanelLines(mission.detailOutput.label, output, width, panelHeight, view.outputScrollOffset);
	view.outputScrollOffset = rendered.clampedOffset;
	return [
		"Mission Control",
		"Read-only detail",
		"",
		...summary,
		"",
		...rendered.lines,
		...(view.showHelp ? ["", ...missionControlHelpLines()] : []),
		"",
		missionControlFooter(width, view),
	];
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

function missionControlLines(cwd: string, _state: MissionOrchestratorSessionState | undefined, width: number, height: number | undefined, view: MissionControlViewState, targetMissionId?: string): string[] {
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
		return fitToViewport(["Mission Control", "Read-only overview", "", "No visible missions found.", "Start one with /missions [goal].", "", missionControlFooter(safeWidth, view)], safeWidth, height);
	}
	const selected = selectedMissionView(vm, view, targetMissionId);
	if (selected) view.selectedMissionId = selected.id;
	if (targetMissionId) view.mode = "detail";
	const lines = view.mode === "detail" && selected
		? missionControlDetailLines(selected, view, safeWidth, height)
		: missionControlOverviewLines(vm, view, safeWidth);
	return fitToViewport(lines, safeWidth, height);
}

function hasSessionSwitchControls(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as ExtensionCommandContext).newSession === "function" && typeof (ctx as ExtensionCommandContext).switchSession === "function";
}

async function openOrSwitchMissionOrchestratorSession(ctx: ExtensionCommandContext, mission: MissionState): Promise<void> {
	const existing = readOrchestratorSessionRecord(ctx.cwd, mission.id);
	const content = runningMissionOrchestratorContext(ctx.cwd, mission);
	if (existing?.sessionPath && fs.existsSync(existing.sessionPath)) {
		if (!existing.active) {
			writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
				sessionId: existing.sessionId,
				sessionPath: existing.sessionPath,
				createdAt: existing.createdAt,
				active: true,
			});
		}
		await ctx.switchSession(existing.sessionPath, {
			withSession: async (nextCtx) => {
				await nextCtx.sendMessage({ customType: "missions-running-orchestrator", display: true, content, details: { missionId: mission.id, missionDir: missionDir(ctx.cwd, mission.id), reusedSession: true } }, { deliverAs: "followUp" });
			},
		});
		return;
	}
	let createdSessionPath = "";
	await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile(),
		setup: async (sessionManager) => {
			createdSessionPath = sessionManager.getSessionFile() || "";
			sessionManager.appendSessionInfo(`Mission orchestrator: ${mission.title}`);
			sessionManager.appendCustomEntry(ORCHESTRATOR_STATE_ENTRY, buildOrchestratorState(ctx.cwd, mission, { activeMissionId: mission.id, activePlanningMissionId: undefined, activeRunningMissionId: mission.id }));
			writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
				sessionId: createdSessionPath ? path.basename(createdSessionPath, path.extname(createdSessionPath)) : `pid-${process.pid}`,
				sessionPath: createdSessionPath || ctx.sessionManager.getSessionFile() || "",
				createdAt: nowIso(),
				active: true,
			});
		},
		withSession: async (nextCtx) => {
			await nextCtx.sendMessage({ customType: "missions-running-orchestrator", display: true, content, details: { missionId: mission.id, missionDir: missionDir(ctx.cwd, mission.id), sessionPath: createdSessionPath } }, { triggerTurn: true, deliverAs: "followUp" });
		},
	});
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

async function openMissionControl(ctx: ExtensionContext, state: MissionOrchestratorSessionState | undefined, targetMissionId: string | undefined, pi: ExtensionAPI): Promise<MissionCommandResult> {
	if (!ctx.hasUI) {
		const text = "Mission Control requires an interactive UI.";
		ctx.ui.notify(text, "warning");
		return { ok: false, text };
	}
	if (targetMissionId) {
		try {
			loadMission(ctx.cwd, targetMissionId);
		} catch {
			const text = `Mission not found: ${targetMissionId}`;
			ctx.ui.notify(text, "warning");
			return { ok: false, text };
		}
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

async function startMissionOrchestrator(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const goal = args.trim();
	const modelStatus = await applyGlobalOrchestratorModelDefault(ctx, pi);
	pi.appendEntry(PLANNING_KICKOFF_ENTRY, { schemaVersion: 1, cwd: ctx.cwd, goal, createdAt: nowIso(), orchestratorModelStatus: modelStatus });
	ctx.ui.notify("Mission orchestrator loaded in this session.", "info");
	pi.sendMessage({
		customType: "missions-planning-kickoff",
		display: false,
		content: missionPlanningKickoffContext(ctx.cwd, goal),
		details: { cwd: ctx.cwd, orchestratorModelStatus: modelStatus },
	}, { triggerTurn: true });
}

function persistedPlanStatus(incomingStatus: Status | undefined, existingMission?: MissionState): Status {
	const existingIsStartedOrTerminal = existingMission && existingMission.status !== "planning" && existingMission.status !== "planned";
	if (!existingIsStartedOrTerminal) return "planned";
	if (!incomingStatus || incomingStatus === "planning" || incomingStatus === "planned") {
		if (existingMission.status === "complete" || existingMission.status === "failed") return "planned";
		return existingMission.status;
	}
	return incomingStatus;
}

function createMissionId(): string {
	const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
	const rand = Math.random().toString(36).slice(2, 8);
	return `mission-${ts}-${rand}`;
}

function createPlanningMission(cwd: string, requestedId?: string): MissionState {
	const id = requestedId || createMissionId();
	return {
		schemaVersion: 1,
		id,
		title: "Planning...",
		status: "planning",
		createdAt: nowIso(),
		updatedAt: nowIso(),
		cwd,
		models: readMissionGlobalSettings(cwd).models,
		milestones: [],
	};
}

function featureStatusById(mission: MissionState): Map<string, ItemStatus> {
	const statuses = new Map<string, ItemStatus>();
	for (const milestone of missionMilestones(mission)) {
		for (const feature of milestone.features) statuses.set(feature.id, feature.status);
	}
	return statuses;
}

function areFeatureDependenciesSatisfied(feature: MissionFeature, statuses: Map<string, ItemStatus>): boolean {
	return (feature.dependencies ?? []).every((dependencyId) => {
		const dependencyStatus = statuses.get(dependencyId);
		return dependencyStatus === "complete" || dependencyStatus === "skipped";
	});
}

function milestoneForFeature(mission: MissionState, featureId: string): MissionMilestone | undefined {
	return missionMilestones(mission).find((milestone) => milestone.features.some((feature) => feature.id === featureId));
}

function findNextFeature(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	const statuses = featureStatusById(mission);
	for (const feature of missionFeatureList(mission)) {
		if (feature.status === "complete" || feature.status === "skipped") continue;
		if (!areFeatureDependenciesSatisfied(feature, statuses)) return undefined;
		const milestone = milestoneForFeature(mission, feature.id);
		return feature.status === "pending" ? (milestone ? { milestone, feature } : undefined) : undefined;
	}
	return undefined;
}

function featureHandoffExists(mission: MissionState, feature: MissionFeature): boolean {
	return Boolean(feature.runId && fs.existsSync(path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId, "handoff.json")));
}

function featureAwaitingValidation(mission: MissionState, feature: MissionFeature): boolean {
	if (!featureHandoffExists(mission, feature)) return false;
	if (feature.reviewerPending || (isFeatureReviewRequired(feature) && !(feature.reviewerRunIds?.length))) return false;
	if (feature.status === "running") return !feature.validationRunId;
	// Recovery repair may reset a worker-success feature to pending while preserving
	// its run/commit. If it has not had any validation attempt yet, validate that
	// existing implementation before launching later feature work.
	return feature.status === "pending" && Boolean(feature.commit) && !feature.validationRunId;
}

function reviewerConfig(feature: MissionFeature): Array<{ id: string; focusAreas?: string; instructions?: string }> {
	return (feature.reviewers ?? []).filter((reviewer) => typeof reviewer?.id === "string" && reviewer.id.trim()).map((reviewer) => ({
		id: reviewer.id.trim(),
		focusAreas: typeof reviewer.focusAreas === "string" && reviewer.focusAreas.trim() ? reviewer.focusAreas.trim() : undefined,
		instructions: typeof reviewer.instructions === "string" && reviewer.instructions.trim() ? reviewer.instructions.trim() : undefined,
	}));
}

function isFeatureReviewRequired(feature: MissionFeature): boolean {
	return reviewerConfig(feature).length > 0;
}

function featureAwaitingUserTesting(feature: MissionFeature): boolean {
	if (!isFeatureUserTestingRequired(feature)) return false;
	if (feature.status !== "running") return false;
	if (!feature.validationRunId || feature.userTestingRunId) return false;
	// Backward compatibility for already-persisted F2 states before userTestingPending
	// existed: if a required feature is running with passed scrutiny and no user-testing
	// run yet, resume user-testing.
	return feature.userTestingPending !== false;
}

function findFeatureAwaitingReviewers(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	const statuses = featureStatusById(mission);
	for (const feature of missionFeatureList(mission)) {
		if (feature.status === "complete" || feature.status === "skipped") continue;
		if (!areFeatureDependenciesSatisfied(feature, statuses)) return undefined;
		if (feature.status === "running" && (feature.reviewerPending || (isFeatureReviewRequired(feature) && !(feature.reviewerRunIds?.length)))) {
			const milestone = milestoneForFeature(mission, feature.id);
			return milestone ? { milestone, feature } : undefined;
		}
		if (featureAwaitingValidation(mission, feature)) return undefined;
		if (feature.status === "pending") return undefined;
		return undefined;
	}
	return undefined;
}

function findFeatureAwaitingUserTesting(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	const statuses = featureStatusById(mission);
	for (const feature of missionFeatureList(mission)) {
		if (feature.status === "complete" || feature.status === "skipped") continue;
		if (!areFeatureDependenciesSatisfied(feature, statuses)) return undefined;
		if (featureAwaitingUserTesting(feature)) {
			const milestone = milestoneForFeature(mission, feature.id);
			return milestone ? { milestone, feature } : undefined;
		}
		if (featureAwaitingValidation(mission, feature)) return undefined;
		if (feature.status === "pending") return undefined;
		return undefined;
	}
	return undefined;
}

function findFeatureAwaitingValidation(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	const statuses = featureStatusById(mission);
	for (const feature of missionFeatureList(mission)) {
		if (feature.status === "complete" || feature.status === "skipped") continue;
		if (!areFeatureDependenciesSatisfied(feature, statuses)) return undefined;
		if (featureAwaitingValidation(mission, feature)) {
			const milestone = milestoneForFeature(mission, feature.id);
			return milestone ? { milestone, feature } : undefined;
		}
		// Sequential execution invariant: do not scan past an incomplete earlier
		// feature. If it is not ready for validation, normal worker selection or
		// no-runnable-work handling must deal with this feature before later ones.
		return undefined;
	}
	return undefined;
}

function incompleteFeatures(mission: MissionState): Array<{ milestone: MissionMilestone; feature: MissionFeature; unsatisfiedDependencies: string[] }> {
	const statuses = featureStatusById(mission);
	const incomplete: Array<{ milestone: MissionMilestone; feature: MissionFeature; unsatisfiedDependencies: string[] }> = [];
	for (const feature of missionFeatureList(mission)) {
		if (feature.status === "complete" || feature.status === "skipped") continue;
		const unsatisfiedDependencies = (feature.dependencies ?? []).filter((dependencyId) => {
			const dependencyStatus = statuses.get(dependencyId);
			return dependencyStatus !== "complete" && dependencyStatus !== "skipped";
		});
		const milestone = milestoneForFeature(mission, feature.id);
		if (milestone) incomplete.push({ milestone, feature, unsatisfiedDependencies });
	}
	return incomplete;
}

function normalizeBlockedFeatureForRetry(mission: MissionState, feature: MissionFeature): boolean {
	if (feature.status === "failed" || feature.status === "running") {
		feature.status = "pending";
		feature.validationRunId = undefined;
		feature.userTestingRunId = undefined;
		feature.reviewerRunIds = undefined;
		feature.userTestingPending = false;
		feature.reviewerPending = false;
		return true;
	}
	return false;
}

function repairMissionExecutionGateState(_cwd: string, mission: MissionState): { changed: boolean; reasons: string[] } {
	const reasons: string[] = [];
	let changed = false;
	const features = missionFeatureList(mission);
	const block = latestBlockFromArtifacts(mission);
	const recoveryPlan = computeRecoveryGatePlan({
		featureOrder: features.map((feature) => feature.id),
		featureStatusById: Object.fromEntries(features.map((feature) => [feature.id, feature.status])),
		blockedFeatureId: block?.featureId,
		currentFeatureId: mission.currentFeatureId,
		activeRunItemId: mission.activeRun?.itemId,
		missionStatus: mission.status,
	});
	if (!recoveryPlan.gateFeatureId) return { changed: false, reasons };
	const gateFeature = features.find((feature) => feature.id === recoveryPlan.gateFeatureId);
	if (!gateFeature) return { changed: false, reasons };
	const gateMilestone = milestoneForFeature(mission, gateFeature.id);
	if (!gateMilestone) return { changed: false, reasons };
	if (recoveryPlan.normalizeGateToPending && normalizeBlockedFeatureForRetry(mission, gateFeature)) {
		changed = true;
		reasons.push(`reset gate feature ${gateFeature.id} status to pending for retry`);
	}
	if (recoveryPlan.setCurrentFeatureToGate) {
		mission.currentFeatureId = gateFeature.id;
		changed = true;
		reasons.push(`set currentFeatureId to gate feature ${gateFeature.id}`);
	}
	if (mission.currentMilestoneId !== gateMilestone.id) {
		mission.currentMilestoneId = gateMilestone.id;
		changed = true;
		reasons.push(`set currentMilestoneId to ${gateMilestone.id}`);
	}
	if (mission.activeRun && recoveryPlan.clearActiveRun) {
		const staleRunId = mission.activeRun.runId;
		const activeItemId = mission.activeRun.itemId;
		clearActiveRunOwnership(mission);
		changed = true;
		reasons.push(`cleared stale activeRun ${staleRunId} beyond gate feature ${gateFeature.id}`);
		reasons.push(`reconciled active run item ${activeItemId} to blocked gate ${gateFeature.id}`);
	}
	if (recoveryPlan.forceBlockedStatus) {
		mission.status = "blocked";
		changed = true;
		reasons.push(`forced mission status to blocked until gate feature ${gateFeature.id} passes validation`);
	}
	return { changed, reasons };
}

type MissionLifecycleEvaluation = "active" | "blocked" | "complete" | "interrupted";

function transitionFeaturePendingToWorkerRunning(mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, runId: string): void {
	feature.status = "running";
	feature.runId = runId;
	mission.status = "running";
	mission.currentMilestoneId = milestone.id;
	mission.currentFeatureId = feature.id;
	milestone.status = "running";
}

function transitionWorkerSuccessToValidatorRunning(mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, runId: string): void {
	feature.validationRunId = runId;
	feature.status = "running";
	mission.status = "running";
	mission.currentMilestoneId = milestone.id;
	mission.currentFeatureId = feature.id;
	milestone.status = "running";
}

function isFeatureUserTestingRequired(feature: MissionFeature): boolean {
	return feature.userTesting?.required === true;
}

function featureUserTestingInstructions(feature: MissionFeature): string | undefined {
	const instructions = feature.userTesting?.instructions;
	return typeof instructions === "string" && instructions.trim() ? instructions.trim() : undefined;
}

function clearResolvedFeatureBlock(mission: MissionState, featureId: string): void {
	if (mission.latestBlock?.featureId === featureId || mission.latestBlock?.failedItemId === featureId) {
		mission.latestBlock = undefined;
	}
}

function transitionValidatorPassToFeatureComplete(mission: MissionState, milestone: MissionMilestone, feature: MissionFeature): void {
	feature.status = "complete";
	feature.userTestingPending = false;
	feature.reviewerPending = false;
	clearResolvedFeatureBlock(mission, feature.id);
	milestone.status = milestone.features.every((item) => item.status === "complete" || item.status === "skipped") ? "complete" : "pending";
	mission.status = "running";
}

function transitionValidatorFailToFeaturePendingForRetry(mission: MissionState, feature: MissionFeature): void {
	feature.status = "pending";
	feature.userTestingPending = false;
	feature.reviewerRunIds = undefined;
	feature.reviewerPending = false;
	mission.status = "running";
}

function transitionFeatureToUserTestingRunning(mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, runId: string): void {
	feature.userTestingRunId = runId;
	feature.userTestingPending = false;
	feature.status = "running";
	mission.status = "running";
	mission.currentMilestoneId = milestone.id;
	mission.currentFeatureId = feature.id;
	milestone.status = "running";
}

function transitionUserTestingFailToFeaturePendingAndMissionBlocked(mission: MissionState, feature: MissionFeature): void {
	feature.status = "pending";
	feature.userTestingPending = false;
	feature.reviewerPending = false;
	mission.status = "blocked";
}

function transitionMissionPauseAfterCurrent(mission: MissionState, requestedAt: string): void {
	mission.status = "paused";
	mission.pauseRequestedAt = requestedAt;
}

function transitionMissionResumeFromPause(mission: MissionState): void {
	mission.status = "running";
	mission.pauseRequestedAt = undefined;
}

function transitionMissionNoRunnablePendingWorkToBlocked(mission: MissionState): void {
	mission.status = "blocked";
}

function transitionMissionToComplete(mission: MissionState): void {
	mission.status = "complete";
	mission.latestBlock = undefined;
	for (const milestone of missionMilestones(mission)) {
		if (milestone.status !== "complete") milestone.status = "complete";
	}
}

function evaluateMissionLifecycleTransition(mission: MissionState, lifecycle: MissionRunLifecycleClassification): MissionLifecycleEvaluation {
	if (mission.status === "complete") return "complete";
	if (mission.status === "blocked" || mission.status === "failed") return "blocked";
	if (lifecycle.state === "interrupted") return "interrupted";
	return "active";
}

function writeNoRunnablePendingWorkReport(runDir: string, mission: MissionState, pending: ReturnType<typeof incompleteFeatures>): MissionBlockSummary {
	ensureDir(runDir);
	const primary = pending[0];
	const report = {
		schemaVersion: 1,
		timestamp: nowIso(),
		missionId: mission.id,
		missionTitle: mission.title,
		reason: "No pending feature is currently runnable, but incomplete feature work remains.",
		pendingFeatures: pending.map(({ milestone, feature, unsatisfiedDependencies }) => ({
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			status: feature.status,
			dependencies: feature.dependencies ?? [],
			unsatisfiedDependencies,
		})),
	};
	const reportJson = path.join(runDir, "unresolved-pending-work.json");
	const reportMd = path.join(runDir, "unresolved-pending-work.md");
	writeJson(reportJson, report);
	fs.writeFileSync(reportMd, [
		"# Unresolved pending mission work",
		"",
		"Mission execution stopped because no pending feature is runnable, but incomplete feature work remains. This usually means dependencies are unsatisfied, missing, failed, or otherwise invalid in the persisted plan.",
		"",
		...report.pendingFeatures.flatMap((feature) => [
			`- ${feature.featureId} - ${feature.featureTitle} (${feature.status})`,
			`  - milestone: ${feature.milestoneId} - ${feature.milestoneTitle}`,
			`  - dependencies: ${feature.dependencies.length > 0 ? feature.dependencies.join(", ") : "none"}`,
			`  - unsatisfied dependencies: ${feature.unsatisfiedDependencies.length > 0 ? feature.unsatisfiedDependencies.join(", ") : "none"}`,
		]),
		"",
	].join("\n"));
	return {
		kind: "worker",
		missionId: mission.id,
		missionTitle: mission.title,
		milestoneId: primary?.milestone.id ?? mission.currentMilestoneId ?? "unknown",
		milestoneTitle: primary?.milestone.title ?? mission.currentMilestoneId ?? "Unknown milestone",
		featureId: primary?.feature.id,
		featureTitle: primary?.feature.title,
		runId: path.basename(runDir),
		runDir,
		exitCode: 0,
		status: "no runnable pending work",
		artifactPaths: existingPaths([reportJson, reportMd]),
	};
}

function shouldAutoResumeAfterPlanRevision(_cwd: string, _existingMission: MissionState | undefined, _revisedMission: MissionState): boolean {
	// Plan revision is a control-plane mutation, not execution confirmation. Auto
	// resuming a blocked mission from mission_write_plan caused dogfooding runs to
	// continue while the orchestrator was still repairing state. Keep revisions
	// inert; users can explicitly resume via /missions run or Mission Control.
	return false;
}

async function runWorker(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, signal?: AbortSignal): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-worker-${feature.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	transitionFeaturePendingToWorkerRunning(mission, milestone, feature, runId);
	const ownership = setActiveRunOwnership(mission, { kind: "worker", itemId: feature.id, runId });
	saveMission(mission.cwd, mission);
	persistRunOwnershipArtifact(runDir, ownership);
	const workerSessionRecord: MissionChildSessionRecord = {
		schemaVersion: 1,
		missionId: mission.id,
		runId,
		role: "worker",
		featureId: feature.id,
		milestoneId: milestone.id,
		attempt: nextChildAttemptNumber(mission.cwd, mission.id, "worker", feature.id),
		status: "running",
		runDir,
		transcriptPath: path.join(runDir, "transcript.jsonl"),
		stderrPath: path.join(runDir, "stderr.txt"),
		sessionId: parseRunOwnershipSessionId(runDir),
		startedAt: nowIso(),
	};
	upsertChildSessionRecord(mission.cwd, mission.id, workerSessionRecord);
	updateWidget(ctx, mission);
	appendEvent(dir, "worker_started", { milestoneId: milestone.id, featureId: feature.id, runId, ownership, childSession: workerSessionRecord });

	const prompt = `Use the mission-worker skill and the mission-specific worker skill if present. Implement exactly one mission feature.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature: ${feature.id} - ${feature.title}\n\nFeature description:\n${feature.description}\n\nRequired outputs: commit code changes with git, then write handoff.json and handoff.md in the run directory. If blocked, write handoff files explaining why.

Do not stop after stating that you will implement. Use tools to complete the work before any final response. Your final response is allowed only after the commit and handoff artifacts exist, or after blocked handoff artifacts exist.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		prompt,
		model: resolveRoleModel(mission.cwd, mission, "worker"),
		systemPromptFiles: [BASE_SKILLS.worker, path.join(dir, "skills/worker/SKILL.md")],
		transcriptFile: path.join(runDir, "transcript.jsonl"),
		signal,
		onUpdate: (text) => updateMissionRunStatus(ctx, `Worker ${feature.id}`, text),
	});
	fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
	appendEvent(dir, "worker_finished", { featureId: feature.id, runId, exitCode: result.exitCode });

	let handoff: any = undefined;
	let handoffSchemaError: string | undefined;
	const handoffFile = path.join(runDir, "handoff.json");
	if (fs.existsSync(handoffFile)) {
		try {
			const parsed = readJson<any>(handoffFile);
			const validation = validateMissionArtifact("worker-handoff", parsed);
			if (validation.ok) handoff = parsed;
			else {
				handoffSchemaError = artifactValidationErrorSummary("worker-handoff", validation.issues);
				appendEvent(dir, "handoff_parse_error", { featureId: feature.id, error: handoffSchemaError, issues: validation.issues });
			}
		} catch (error) {
			handoffSchemaError = `Worker handoff.json parse error: ${String(error)}`;
			appendEvent(dir, "handoff_parse_error", { featureId: feature.id, error: String(error) });
		}
	}
	const dirty = await gitPorcelain(mission.cwd);
	const head = await gitHead(mission.cwd);
	if (!handoff && !handoffSchemaError && result.exitCode === 0 && !dirty) {
		handoff = synthesizeWorkerHandoffArtifacts(runDir, feature, result, head);
		appendEvent(dir, "worker_handoff_synthesized", { featureId: feature.id, runId, commit: head });
	}
	feature.commit = handoff?.commit || head;
	let block: MissionBlockSummary | undefined;
	if (result.exitCode !== 0 || !handoff || dirty) {
		const autoRetry = result.exitCode === 0 && !handoff && !handoffSchemaError && !dirty;
		feature.status = autoRetry ? "pending" : "failed";
		mission.status = autoRetry ? "running" : "blocked";
		appendEvent(dir, autoRetry ? "worker_missing_handoff_auto_retry" : "worker_failed", { featureId: feature.id, dirty, hasHandoff: Boolean(handoff), autoRetry });
		block = {
			kind: "worker",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: handoff?.status ?? (handoffSchemaError ? "invalid handoff schema" : (!handoff ? "missing handoff" : undefined)),
			dirty: dirty || undefined,
			artifactPaths: existingPaths([handoffFile, path.join(runDir, "handoff.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	} else if (handoff.status === "complete") {
		// Worker success is an implementation attempt. The feature is marked
		// complete only after feature-level validation passes.
		feature.status = "running";
		feature.reviewerPending = isFeatureReviewRequired(feature);
	} else {
		feature.status = handoff.status === "blocked" ? "failed" : "failed";
		mission.status = "blocked";
		block = {
			kind: "worker",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: handoff.status,
			artifactPaths: existingPaths([handoffFile, path.join(runDir, "handoff.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	}
	if (block) persistMissionBlock(dir, mission, block, classifyWorkerBlock(result, handoff, dirty));
	const workerTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
	upsertChildSessionRecord(mission.cwd, mission.id, {
		...workerSessionRecord,
		status: block ? (block.status ?? "failed") : "complete",
		sessionId: workerTranscriptSession.sessionId ?? workerSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
		sessionPath: workerTranscriptSession.sessionPath ?? workerSessionRecord.sessionPath,
		finishedAt: nowIso(),
	});
	clearActiveRunOwnership(mission);
	saveMission(mission.cwd, mission);
	updateWidget(ctx, mission);
	return block;
}

function reviewerEvidenceContext(mission: MissionState, feature: MissionFeature): string {
	const runIds = feature.reviewerRunIds ?? [];
	if (runIds.length === 0) return "Reviewer evidence: none recorded.";
	const lines = ["Reviewer evidence (advisory; treat as inputs, not final verdict):"];
	for (const runId of runIds) {
		const runDir = path.join(missionDir(mission.cwd, mission.id), "runs", runId);
		const reportJson = path.join(runDir, "review-report.json");
		const status = fs.existsSync(reportJson) ? (readJson<{ status?: string }>(reportJson).status ?? "unknown") : "missing";
		lines.push(`- run: ${runId}`);
		lines.push(`  - report: ${fs.existsSync(reportJson) ? reportJson : "missing"}`);
		lines.push(`  - status: ${status}`);
	}
	return lines.join("\n");
}

async function runReviewerFanout(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, signal?: AbortSignal): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const reviewers = reviewerConfig(feature);
	if (reviewers.length === 0) {
		feature.reviewerPending = false;
		saveMission(mission.cwd, mission);
		return undefined;
	}
	const runs = await Promise.all(reviewers.map(async (reviewer) => {
		const runId = `${String(Date.now())}-reviewer-${feature.id}-${reviewer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
		const runDir = path.join(dir, "runs", runId);
		ensureDir(runDir);
		const record: MissionChildSessionRecord = {
			schemaVersion: 1,
			missionId: mission.id,
			runId,
			role: "reviewer",
			reviewerId: reviewer.id,
			featureId: feature.id,
			milestoneId: milestone.id,
			attempt: nextChildAttemptNumber(mission.cwd, mission.id, "reviewer", feature.id),
			status: "running",
			runDir,
			transcriptPath: path.join(runDir, "transcript.jsonl"),
			stderrPath: path.join(runDir, "stderr.txt"),
			sessionId: parseRunOwnershipSessionId(runDir),
			startedAt: nowIso(),
		};
		upsertChildSessionRecord(mission.cwd, mission.id, record);
		const prompt = `Act as a read-only mission reviewer. Do not edit files. Do not run git commit.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature: ${feature.id} - ${feature.title}\nReviewer id: ${reviewer.id}\n${reviewer.focusAreas ? `Focus areas: ${reviewer.focusAreas}\n` : ""}${reviewer.instructions ? `Instructions:\n${reviewer.instructions}\n` : ""}\nWrite review-report.json and review-report.md in the run directory. Findings are advisory for scrutiny validation.`;
		const result = await runPiChild({
			cwd: mission.cwd,
			model: resolveRoleModel(mission.cwd, mission, "validator"),
			systemPromptFiles: [BASE_SKILLS.reviewer, path.join(dir, "skills/reviewer/SKILL.md")],
			prompt,
			transcriptFile: path.join(runDir, "transcript.jsonl"),
			signal,
		});
		fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
		let reportOk = false;
		const reportFile = path.join(runDir, "review-report.json");
		if (fs.existsSync(reportFile)) {
			try {
				const parsed = readJson<any>(reportFile);
				reportOk = validateMissionArtifact("reviewer-report", parsed).ok;
			} catch {
				reportOk = false;
			}
		}
		const session = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
		upsertChildSessionRecord(mission.cwd, mission.id, {
			...record,
			status: result.exitCode === 0 && reportOk ? "complete" : "failed",
			sessionId: session.sessionId ?? record.sessionId,
			sessionPath: session.sessionPath,
			finishedAt: nowIso(),
		});
		appendEvent(dir, "reviewer_finished", { featureId: feature.id, reviewerId: reviewer.id, runId, exitCode: result.exitCode, reportOk });
		return { runId, runDir, exitCode: result.exitCode, reportOk };
	}));
	feature.reviewerRunIds = runs.map((run) => run.runId);
	feature.reviewerPending = false;
	saveMission(mission.cwd, mission);
	const failed = runs.find((run) => run.exitCode !== 0 || !run.reportOk);
	if (!failed) return undefined;
	mission.status = "blocked";
	const block: MissionBlockSummary = {
		kind: "validator",
		missionId: mission.id,
		missionTitle: mission.title,
		milestoneId: milestone.id,
		milestoneTitle: milestone.title,
		featureId: feature.id,
		featureTitle: feature.title,
		runId: failed.runId,
		runDir: failed.runDir,
		exitCode: failed.exitCode,
		status: "reviewer infrastructure/artifact failure",
		artifactPaths: existingPaths([path.join(failed.runDir, "review-report.json"), path.join(failed.runDir, "review-report.md"), path.join(failed.runDir, "transcript.jsonl"), path.join(failed.runDir, "stderr.txt")]),
	};
	persistMissionBlock(dir, mission, block, "reviewer_infrastructure_failure");
	saveMission(mission.cwd, mission);
	return block;
}

function completedFeatureReviewContext(dir: string, milestone: MissionMilestone): string {
	const completedFeatures = milestone.features.filter((feature) => feature.status === "complete");
	if (completedFeatures.length === 0) return "Completed features available for code review: none recorded.";
	const lines = ["Completed features available for code review:"];
	for (const feature of completedFeatures) {
		const runDir = feature.runId ? path.join(dir, "runs", feature.runId) : undefined;
		const handoffJson = runDir ? path.join(runDir, "handoff.json") : undefined;
		const handoffMd = runDir ? path.join(runDir, "handoff.md") : undefined;
		lines.push(`- ${feature.id} - ${feature.title}`);
		lines.push(`  status: ${feature.status}`);
		lines.push(`  commit: ${feature.commit ?? "not recorded"}`);
		lines.push(`  worker run: ${feature.runId ?? "not recorded"}`);
		lines.push(`  run directory: ${runDir ?? "not recorded"}`);
		lines.push(`  handoff.json: ${handoffJson && fs.existsSync(handoffJson) ? handoffJson : "not available"}`);
		lines.push(`  handoff.md: ${handoffMd && fs.existsSync(handoffMd) ? handoffMd : "not available"}`);
	}
	return lines.join("\n");
}

async function runValidator(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone, signal?: AbortSignal, targetFeature?: MissionFeature): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-validator-${milestone.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	if (targetFeature) transitionWorkerSuccessToValidatorRunning(mission, milestone, targetFeature, runId);
	else {
		setMilestoneValidationRunId(milestone, runId);
		milestone.status = "running";
		mission.status = "running";
		mission.currentMilestoneId = milestone.id;
		mission.currentFeatureId = undefined;
	}
	const ownership = setActiveRunOwnership(mission, { kind: "validator", itemId: targetFeature?.id ?? milestone.id, runId });
	saveMission(mission.cwd, mission);
	persistRunOwnershipArtifact(runDir, ownership);
	const validatorSessionRecord: MissionChildSessionRecord = {
		schemaVersion: 1,
		missionId: mission.id,
		runId,
		role: "validator",
		featureId: targetFeature?.id,
		milestoneId: milestone.id,
		attempt: nextChildAttemptNumber(mission.cwd, mission.id, "validator", targetFeature?.id),
		status: "running",
		runDir,
		transcriptPath: path.join(runDir, "transcript.jsonl"),
		stderrPath: path.join(runDir, "stderr.txt"),
		sessionId: parseRunOwnershipSessionId(runDir),
		startedAt: nowIso(),
	};
	upsertChildSessionRecord(mission.cwd, mission.id, validatorSessionRecord);
	updateWidget(ctx, mission);
	appendEvent(dir, "validator_started", { milestoneId: milestone.id, featureId: targetFeature?.id, runId, ownership, childSession: validatorSessionRecord });
	const featureReviewContext = targetFeature
		? [`Feature attempt available for validation:`, `- ${targetFeature.id} - ${targetFeature.title}`, `  status: ${targetFeature.status}`, `  commit: ${targetFeature.commit ?? "not recorded"}`, `  worker run: ${targetFeature.runId ?? "not recorded"}`, `  run directory: ${targetFeature.runId ? path.join(dir, "runs", targetFeature.runId) : "not recorded"}`, reviewerEvidenceContext(mission, targetFeature)].join("\n")
		: completedFeatureReviewContext(dir, milestone);
	const prompt = `Use the mission-validator skill and the mission-specific scrutiny validator skill if present. Validate this ${targetFeature ? "feature implementation attempt" : "completed milestone"} adversarially.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\n${targetFeature ? `Feature: ${targetFeature.id} - ${targetFeature.title}\n\nFeature description:\n${targetFeature.description}\n` : ""}\n${featureReviewContext}\n\nTreat reviewer reports as advisory evidence only. Reviewer findings or fail/inconclusive statuses should inform this scrutiny report, not automatically accept/reject the feature unless reviewer infrastructure/artifact failures made validation impossible.\n\nPerform a per-feature adversarial code review for each completed feature listed above, using the recorded commits and handoff paths where available. Inspect relevant diffs/handoffs, assess whether tests and procedure were adequate, and report code-review defects or procedure findings. Also check the feature against the validation contract and mission plan. Run appropriate checks. Write validation-report.json and validation-report.md in the run directory.

Do not stop after stating that you will validate. Use tools to complete the validation before any final response. Your final response is allowed only after validation-report.json and validation-report.md exist.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		prompt,
		model: resolveRoleModel(mission.cwd, mission, "validator"),
		systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-scrutiny/SKILL.md")],
		transcriptFile: path.join(runDir, "transcript.jsonl"),
		signal,
		onUpdate: (text) => updateMissionRunStatus(ctx, `Validator ${targetFeature?.id ?? milestone.id}`, text),
	});
	fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
	let report: any = undefined;
	let reportSchemaError: string | undefined;
	const reportFile = path.join(runDir, "validation-report.json");
	if (fs.existsSync(reportFile)) {
		try {
			const parsed = readJson<any>(reportFile);
			const validation = validateMissionArtifact("scrutiny-validation-report", parsed);
			if (validation.ok) report = parsed;
			else {
				reportSchemaError = artifactValidationErrorSummary("scrutiny-validation-report", validation.issues);
				appendEvent(dir, "validation_parse_error", { milestoneId: milestone.id, error: reportSchemaError, issues: validation.issues });
			}
		} catch (error) {
			reportSchemaError = `Scrutiny validation-report.json parse error: ${String(error)}`;
			appendEvent(dir, "validation_parse_error", { milestoneId: milestone.id, error: String(error) });
		}
	}
	if (!(result.exitCode === 0 && report?.status === "pass")) {
		report = ensureValidatorFailureReportArtifacts(runDir, milestone, result, report, reportSchemaError);
	}
	let block: MissionBlockSummary | undefined;
	if (result.exitCode === 0 && report?.status === "pass") {
		if (targetFeature) {
			if (isFeatureUserTestingRequired(targetFeature)) {
				targetFeature.status = "running";
				targetFeature.userTestingPending = true;
				mission.status = "running";
			} else transitionValidatorPassToFeatureComplete(mission, milestone, targetFeature);
		} else {
			milestone.status = "complete";
		}
	} else {
		if (targetFeature) transitionValidatorFailToFeaturePendingForRetry(mission, targetFeature);
		else {
			milestone.status = "failed";
			mission.status = "blocked";
		}
		block = {
			kind: "validator",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: targetFeature?.id,
			featureTitle: targetFeature?.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: report?.status ?? (!report ? "missing validation report" : undefined),
			artifactPaths: existingPaths([reportFile, path.join(runDir, "validation-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	}
	if (block) persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
	appendEvent(dir, "validator_finished", { milestoneId: milestone.id, featureId: targetFeature?.id, runId, exitCode: result.exitCode, status: report?.status });
	const validatorTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
	upsertChildSessionRecord(mission.cwd, mission.id, {
		...validatorSessionRecord,
		status: report?.status ?? (block ? "failed" : "pass"),
		sessionId: validatorTranscriptSession.sessionId ?? validatorSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
		sessionPath: validatorTranscriptSession.sessionPath ?? validatorSessionRecord.sessionPath,
		finishedAt: nowIso(),
	});
	clearActiveRunOwnership(mission);
	saveMission(mission.cwd, mission);
	updateWidget(ctx, mission);
	return block;
}

function ensureUserTestingFailureReportArtifacts(runDir: string, feature: MissionFeature, result: RunResult, report: any, schemaError?: string): any {
	const reportFile = path.join(runDir, "user-testing-report.json");
	const reportMdFile = path.join(runDir, "user-testing-report.md");
	const hasStructuredReport = report && typeof report === "object" && typeof report.status === "string";
	if (hasStructuredReport) return report;
	const synthesized = {
		featureId: feature.id,
		status: "inconclusive",
		summary: schemaError || result.finalText.trim() || "User-testing validator exited without a parseable user-testing-report.json artifact.",
		commandsRun: [] as Array<{ command: string; exitCode: number; notes?: string }>,
	};
	writeJson(reportFile, synthesized);
	if (!fs.existsSync(reportMdFile)) fs.writeFileSync(reportMdFile, `# User Testing Report\n\n- Feature: ${feature.id} - ${feature.title}\n- Status: inconclusive\n\n## Summary\n${synthesized.summary}\n`);
	return synthesized;
}

async function runUserTestingValidator(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone, feature: MissionFeature, signal?: AbortSignal): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-user-testing-${feature.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	transitionFeatureToUserTestingRunning(mission, milestone, feature, runId);
	const ownership = setActiveRunOwnership(mission, { kind: "user-testing-validator", itemId: feature.id, runId });
	saveMission(mission.cwd, mission);
	persistRunOwnershipArtifact(runDir, ownership);
	const validatorSessionRecord: MissionChildSessionRecord = {
		schemaVersion: 1,
		missionId: mission.id,
		runId,
		role: "user-testing-validator",
		featureId: feature.id,
		milestoneId: milestone.id,
		attempt: nextChildAttemptNumber(mission.cwd, mission.id, "user-testing-validator", feature.id),
		status: "running",
		runDir,
		transcriptPath: path.join(runDir, "transcript.jsonl"),
		stderrPath: path.join(runDir, "stderr.txt"),
		sessionId: parseRunOwnershipSessionId(runDir),
		startedAt: nowIso(),
	};
	upsertChildSessionRecord(mission.cwd, mission.id, validatorSessionRecord);
	updateWidget(ctx, mission);
	appendEvent(dir, "user_testing_started", { milestoneId: milestone.id, featureId: feature.id, runId, ownership, childSession: validatorSessionRecord });
	const instructions = featureUserTestingInstructions(feature);
	const prompt = `Use the mission-validator skill and the mission-specific user-testing validator skill if present. Execute user-testing validation for exactly one feature implementation attempt.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature: ${feature.id} - ${feature.title}\n\nFeature description:\n${feature.description}\n\nRequired behavior:\n- Keep testing approach generic across CLI, TUI, API, web, docs/config, and other project types.\n- Do not assume browser-only workflows.\n- Use feature-specific instructions when provided.\n${instructions ? `\nFeature-specific user-testing instructions:\n${instructions}\n` : ""}\nWrite user-testing-report.json and user-testing-report.md in the run directory.\n\nDo not stop after stating that you will validate. Use tools to complete the validation before any final response. Your final response is allowed only after user-testing-report.json and user-testing-report.md exist.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		model: resolveRoleModel(mission.cwd, mission, "validator"),
		systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-user-testing/SKILL.md")],
		prompt,
		transcriptFile: path.join(runDir, "transcript.jsonl"),
		signal,
		onUpdate: (text) => updateMissionRunStatus(ctx, `User-testing ${feature.id}`, text),
	});
	fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
	let report: any = undefined;
	let reportSchemaError: string | undefined;
	const reportFile = path.join(runDir, "user-testing-report.json");
	if (fs.existsSync(reportFile)) {
		try {
			const parsed = readJson<any>(reportFile);
			const validation = validateMissionArtifact("user-testing-report", parsed);
			if (validation.ok) report = parsed;
			else {
				reportSchemaError = artifactValidationErrorSummary("user-testing-report", validation.issues);
				appendEvent(dir, "user_testing_parse_error", { featureId: feature.id, error: reportSchemaError, issues: validation.issues });
			}
		} catch (error) {
			reportSchemaError = `User-testing report parse error: ${String(error)}`;
			appendEvent(dir, "user_testing_parse_error", { featureId: feature.id, error: String(error) });
		}
	}
	if (!(result.exitCode === 0 && report?.status === "pass")) report = ensureUserTestingFailureReportArtifacts(runDir, feature, result, report, reportSchemaError);
	appendEvent(dir, "user_testing_finished", { milestoneId: milestone.id, featureId: feature.id, runId, exitCode: result.exitCode, status: report?.status });
	let block: MissionBlockSummary | undefined;
	if (result.exitCode === 0 && report?.status === "pass") transitionValidatorPassToFeatureComplete(mission, milestone, feature);
	else {
		transitionUserTestingFailToFeaturePendingAndMissionBlocked(mission, feature);
		block = {
			kind: "user-testing-validator",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: report?.status ?? "missing user-testing report",
			artifactPaths: existingPaths([reportFile, path.join(runDir, "user-testing-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	}
	if (block) persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
	const validatorTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
	upsertChildSessionRecord(mission.cwd, mission.id, {
		...validatorSessionRecord,
		status: report?.status ?? (block ? "failed" : "pass"),
		sessionId: validatorTranscriptSession.sessionId ?? validatorSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
		sessionPath: validatorTranscriptSession.sessionPath ?? validatorSessionRecord.sessionPath,
		finishedAt: nowIso(),
	});
	clearActiveRunOwnership(mission);
	saveMission(mission.cwd, mission);
	updateWidget(ctx, mission);
	return block;
}

// Mission Control concurrency/control decision (F1/F7/F11): ctx.ui.custom()
// returns a Promise that settles only when the custom component calls
// done()/closes, so awaiting it before or during runMission would make mission
// execution wait for the user to close the UI. Auto-open Mission Control
// fire-and-forget and keep runMission as the durable execution owner. Closing
// Mission Control only disposes the UI; it does not abort ctx.signal or any
// child worker/validator process. Mutating controls are explicit action-dispatcher
// calls; pause is a durable pause-after-current request, not a child-process kill.
function autoOpenMissionControl(ctx: ExtensionContext, mission: MissionState, pi: ExtensionAPI): void {
	if (!ctx.hasUI) return;
	const state = buildOrchestratorState(ctx.cwd, mission, {
		activeMissionId: mission.id,
		activePlanningMissionId: undefined,
		activeRunningMissionId: mission.id,
	});
	void openMissionControl(ctx, state, undefined, pi).catch((error) => {
		ctx.ui.notify(`Mission Control failed to open: ${error instanceof Error ? error.message : String(error)}`, "warning");
	});
}

function transitionInterruptedOrStaleRunToPausedForResume(mission: MissionState, run?: MissionRunContext): void {
	for (const milestone of missionMilestones(mission)) {
		if ((run?.kind === "validator" || run?.kind === "user-testing-validator") && milestone.id === run.itemId && milestone.status === "running") milestone.status = "pending";
		for (const feature of milestone.features) {
			if (run?.kind === "worker" && feature.id === run.itemId && feature.status === "running") feature.status = "pending";
			if (run?.kind === "validator" && feature.validationRunId === run.runId && feature.status === "running") feature.status = "pending";
			if (run?.kind === "user-testing-validator" && feature.userTestingRunId === run.runId && feature.status === "running") {
				feature.userTestingPending = true;
				feature.userTestingRunId = undefined;
			}
		}
		if (milestone.status === "running" && !milestone.features.some((feature) => feature.status === "running")) milestone.status = "pending";
	}
	mission.status = "paused";
	clearActiveRunOwnership(mission);
}

function resetInterruptedRunForResume(ctx: ExtensionContext, mission: MissionState, lifecycle: MissionRunLifecycleClassification): MissionState {
	const dir = missionDir(mission.cwd, mission.id);
	const run = lifecycle.run;
	const before = {
		status: mission.status,
		currentMilestoneId: mission.currentMilestoneId,
		currentFeatureId: mission.currentFeatureId,
		activeRun: mission.activeRun,
		runId: run?.runId,
		runKind: run?.kind,
		runItemId: run?.itemId,
		reason: lifecycle.reason,
	};
	transitionInterruptedOrStaleRunToPausedForResume(mission, run);
	mission.updatedAt = nowIso();
	appendEvent(dir, "mission_interrupted_run_reset_for_resume", { missionId: mission.id, before });
	clearMissionRunStatus(ctx);
	saveMission(mission.cwd, mission);
	updateWidget(ctx, mission);
	return mission;
}

function startMissionInBackground(missionId: string, ctx: ExtensionContext, pi: ExtensionAPI, source: string): MissionCommandResult {
	const existing = loadMission(ctx.cwd, missionId);
	const missionCwd = existing.cwd;
	const lifecycle = classifyMissionRunLifecycle(missionCwd, existing);
	if (isMissionRunActive(missionCwd, missionId)) return { ok: false, text: `Mission execution is already active for ${missionId}.` };
	if (existing.status === "running" && lifecycle.state === "interrupted") resetInterruptedRunForResume(ctx, existing, lifecycle);
	const dir = missionDir(missionCwd, missionId);
	appendEvent(dir, "mission_background_execution_requested", { missionId, source });
	void runMission(missionId, ctx, pi, { detached: true }).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		try {
			const mission = loadMission(missionCwd, missionId);
			mission.status = mission.status === "complete" ? mission.status : "blocked";
			clearActiveRunOwnership(mission);
			saveMission(mission.cwd, mission);
			appendEvent(dir, "mission_background_execution_failed", { missionId, source, error: message });
			updateWidget(ctx, mission);
		} catch {
			appendEvent(dir, "mission_background_execution_failed", { missionId, source, error: message, artifactUpdateFailed: true });
		}
		clearMissionRunStatus(ctx);
		ctx.ui.notify(`Mission execution failed: ${message}`, "error");
	});
	return { ok: true, text: `Mission execution started in background for ${missionId}. Mission Control remains interactive.` };
}

function executeRunnerCommand(input: RunnerCommandInput, ctx: ExtensionContext, pi: ExtensionAPI, state?: MissionOrchestratorSessionState): MissionCommandResult {
	const missionId = input.missionId || activeMissionFromState(ctx.cwd, state)?.id || latestMission(ctx.cwd)?.id;
	if (!missionId) return { ok: false, text: "No mission found." };
	const mission = loadMission(ctx.cwd, missionId);
	const missionCwd = mission.cwd;
	const dir = missionDir(missionCwd, missionId);
	if (input.command === "status") return { ok: true, text: summarizeMission(mission), details: { missionId } };
	if (input.command === "start" || input.command === "resume") {
		return startMissionInBackground(missionId, ctx, pi, input.source);
	}
	if (input.command === "pause-after-current") {
		if (mission.status !== "running") return { ok: false, text: `Mission ${missionId} is not running.` };
		return requestMissionPauseAfterCurrent(missionCwd, mission, input.source);
	}
	if (input.command === "cancel-current-child") {
		const canceled = tryCancelCurrentChild(missionCwd, missionId);
		appendEvent(dir, "mission_current_child_cancel_requested", { missionId, source: input.source, canceled });
		return canceled
			? { ok: true, text: `Cancellation requested for current child of ${missionId}.` }
			: { ok: false, text: `No cancelable child is active for ${missionId}.` };
	}
	if (input.command === "retry-feature") {
		if (isMissionRunActive(missionCwd, missionId)) return { ok: false, text: `Mission ${missionId} is currently running.` };
		const featureId = input.featureId || mission.currentFeatureId;
		if (!featureId) return { ok: false, text: "No feature id provided for retry." };
		const feature = missionFeatureList(mission).find((item) => item.id === featureId);
		if (!feature) return { ok: false, text: `Feature not found: ${featureId}.` };
		feature.status = "pending";
		feature.runId = undefined;
		feature.validationRunId = undefined;
		feature.userTestingRunId = undefined;
		feature.reviewerRunIds = undefined;
		feature.userTestingPending = false;
		feature.reviewerPending = false;
		mission.status = "blocked";
		mission.updatedAt = nowIso();
		saveMission(missionCwd, mission);
		appendEvent(dir, "mission_feature_retry_requested", { missionId, featureId, source: input.source });
		return { ok: true, text: `Feature ${featureId} reset to pending for retry.` };
	}
	if (input.command === "block") {
		if (isMissionRunActive(missionCwd, missionId)) return { ok: false, text: `Mission ${missionId} is currently running.` };
		mission.status = "blocked";
		mission.updatedAt = nowIso();
		saveMission(missionCwd, mission);
		appendEvent(dir, "mission_block_manual", { missionId, source: input.source, reason: input.reason });
		return { ok: true, text: `Mission ${missionId} marked blocked.` };
	}
	if (input.command === "unblock") {
		if (isMissionRunActive(missionCwd, missionId)) return { ok: false, text: `Mission ${missionId} is currently running.` };
		if (mission.status !== "blocked") return { ok: false, text: `Mission ${missionId} is not blocked.` };
		mission.status = "paused";
		mission.updatedAt = nowIso();
		saveMission(missionCwd, mission);
		appendEvent(dir, "mission_unblock_manual", { missionId, source: input.source, reason: input.reason });
		return { ok: true, text: `Mission ${missionId} unblocked to paused state.` };
	}
	return { ok: false, text: `Unsupported runner command: ${input.command}` };
}

class MissionExecutionRunner {
	constructor(
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly missionId: string,
		private readonly dir: string,
		private readonly childSignal?: AbortSignal,
	) {}

	async run(): Promise<void> {
		while (true) {
			let mission = loadMission(this.ctx.cwd, this.missionId);
			const awaitingReviewers = findFeatureAwaitingReviewers(mission);
			if (awaitingReviewers) {
				const reviewerBlock = await runReviewerFanout(this.ctx, mission, awaitingReviewers.milestone, awaitingReviewers.feature, this.childSignal);
				mission = loadMission(this.ctx.cwd, this.missionId);
				if (mission.status === "blocked" || mission.status === "failed") {
					if (reviewerBlock) emitMissionBlockMessage(this.pi, reviewerBlock);
					this.ctx.ui.notify(`Reviewer fanout blocked mission. See ${this.dir}`, "error");
					clearMissionRunStatus(this.ctx);
					return;
				}
				if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `reviewer:${awaitingReviewers.feature.id}`)) return;
				continue;
			}
			const awaitingUserTesting = findFeatureAwaitingUserTesting(mission);
			if (awaitingUserTesting) {
				const userTestingBlock = await runUserTestingValidator(this.ctx, mission, awaitingUserTesting.milestone, awaitingUserTesting.feature, this.childSignal);
				mission = loadMission(this.ctx.cwd, this.missionId);
				if (mission.status === "blocked" || mission.status === "failed") {
					if (userTestingBlock) emitMissionBlockMessage(this.pi, userTestingBlock);
					this.ctx.ui.notify(`User testing blocked mission. See ${this.dir}`, "error");
					clearMissionRunStatus(this.ctx);
					return;
				}
				if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `user-testing:${awaitingUserTesting.feature.id}`)) return;
				continue;
			}
			const awaitingValidation = findFeatureAwaitingValidation(mission);
			if (awaitingValidation) {
				const validatorBlock = await runValidator(this.ctx, mission, awaitingValidation.milestone, this.childSignal, awaitingValidation.feature);
				mission = loadMission(this.ctx.cwd, this.missionId);
				if (mission.status === "blocked" || mission.status === "failed") {
					if (validatorBlock) emitMissionBlockMessage(this.pi, validatorBlock);
					this.ctx.ui.notify(`Validation blocked mission. See ${this.dir}`, "error");
					clearMissionRunStatus(this.ctx);
					return;
				}
				if (validatorBlock) appendEvent(this.dir, "feature_validation_failed_auto_retry", { featureId: awaitingValidation.feature.id, runId: validatorBlock.runId, status: validatorBlock.status });
				if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `validator:${awaitingValidation.feature.id}`)) return;
				continue;
			}
			const next = findNextFeature(mission);
			if (!next) break;
			const workerBlock = await runWorker(this.ctx, mission, next.milestone, next.feature, this.childSignal);
			mission = loadMission(this.ctx.cwd, this.missionId);
			if (mission.status === "blocked" || mission.status === "failed") {
				if (workerBlock) emitMissionBlockMessage(this.pi, workerBlock);
				this.ctx.ui.notify(`Mission blocked. See ${this.dir}`, "error");
				clearMissionRunStatus(this.ctx);
				return;
			}
			if (workerBlock) appendEvent(this.dir, "worker_failure_auto_retry", { featureId: next.feature.id, runId: workerBlock.runId, status: workerBlock.status });
			if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `worker:${next.feature.id}`)) return;
			const milestone = missionMilestones(mission).find((m) => m.id === next.milestone.id)!;
			const feature = milestone.features.find((f) => f.id === next.feature.id)!;
			if (feature.reviewerPending) {
				const reviewerBlock = await runReviewerFanout(this.ctx, mission, milestone, feature, this.childSignal);
				mission = loadMission(this.ctx.cwd, this.missionId);
				if (mission.status === "blocked" || mission.status === "failed") {
					if (reviewerBlock) emitMissionBlockMessage(this.pi, reviewerBlock);
					this.ctx.ui.notify(`Reviewer fanout blocked mission. See ${this.dir}`, "error");
					clearMissionRunStatus(this.ctx);
					return;
				}
				if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `reviewer:${next.feature.id}`)) return;
			}
			const validatorBlock = await runValidator(this.ctx, mission, milestone, this.childSignal, feature);
			mission = loadMission(this.ctx.cwd, this.missionId);
			if (mission.status === "blocked" || mission.status === "failed") {
				if (validatorBlock) emitMissionBlockMessage(this.pi, validatorBlock);
				this.ctx.ui.notify(`Validation blocked mission. See ${this.dir}`, "error");
				clearMissionRunStatus(this.ctx);
				return;
			}
			if (isFeatureUserTestingRequired(feature)) {
				const updatedMilestone = missionMilestones(mission).find((m) => m.id === milestone.id)!;
				const updatedFeature = updatedMilestone.features.find((f) => f.id === feature.id)!;
				const userTestingBlock = await runUserTestingValidator(this.ctx, mission, updatedMilestone, updatedFeature, this.childSignal);
				mission = loadMission(this.ctx.cwd, this.missionId);
				if (mission.status === "blocked" || mission.status === "failed") {
					if (userTestingBlock) emitMissionBlockMessage(this.pi, userTestingBlock);
					this.ctx.ui.notify(`User testing blocked mission. See ${this.dir}`, "error");
					clearMissionRunStatus(this.ctx);
					return;
				}
				if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `user-testing:${next.feature.id}`)) return;
			} else if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `validator:${next.feature.id}`)) return;
		}
		const mission = loadMission(this.ctx.cwd, this.missionId);
		const pending = incompleteFeatures(mission);
		if (pending.length > 0) {
			transitionMissionNoRunnablePendingWorkToBlocked(mission);
			const runId = `${String(Date.now())}-blocked-no-runnable-pending-work`;
			const runDir = path.join(this.dir, "runs", runId);
			const block = writeNoRunnablePendingWorkReport(runDir, mission, pending);
			persistMissionBlock(this.dir, mission, block, "no_runnable_pending_work");
			saveMission(this.ctx.cwd, mission);
			updateWidget(this.ctx, mission);
			emitMissionBlockMessage(this.pi, block);
			this.ctx.ui.notify(`Mission blocked: pending work remains but no feature is runnable. See ${runDir}`, "error");
			clearMissionRunStatus(this.ctx);
			return;
		}
		transitionMissionToComplete(mission);
		saveMission(this.ctx.cwd, mission);
		appendEvent(this.dir, "mission_complete", {});
		updateWidget(this.ctx, mission);
		clearMissionRunStatus(this.ctx);
		this.ctx.ui.notify(`Mission complete: ${mission.title}`, "info");
	}
}

async function runMission(args: string, ctx: ExtensionContext, pi: ExtensionAPI, options: { detached?: boolean } = {}): Promise<void> {
	const id = args.trim() || latestMission(ctx.cwd)?.id;
	if (!id) {
		ctx.ui.notify("No mission found. Start with /missions [goal] and persist a plan first.", "warning");
		return;
	}
	let mission = loadMission(ctx.cwd, id);
	const missionCwd = mission.cwd;
	const dir = missionDir(missionCwd, id);
	const gateRepair = repairMissionExecutionGateState(missionCwd, mission);
	if (gateRepair.changed) {
		saveMission(missionCwd, mission);
		appendEvent(dir, "mission_recovery_gate_repaired", { missionId: mission.id, reasons: gateRepair.reasons, latestBlock: mission.latestBlock });
		ctx.ui.notify(`Mission recovery repaired execution gate: ${gateRepair.reasons.join("; ")}`, "warning");
	}
	if (mission.status === "planning") {
		ctx.ui.notify("Mission is still in interactive planning. Ask the orchestrator to persist a runnable plan first.", "warning");
		return;
	}
	if (mission.status === "complete") {
		ctx.ui.notify("Mission is already complete.", "info");
		return;
	}
	if (mission.status === "running") {
		const lifecycle = classifyMissionRunLifecycle(missionCwd, mission);
		if (lifecycle.state === "interrupted") {
			mission = resetInterruptedRunForResume(ctx, mission, lifecycle);
			ctx.ui.notify(`Interrupted mission run reset for resume: ${lifecycle.reason}`, "warning");
		} else {
			const pendingPause = readMissionPauseRequest(missionCwd, mission.id);
			ctx.ui.notify(pendingPause ? "Mission is running with a pending pause-after-current request. Wait for the current worker/validator to finish before resuming." : "Mission is already running.", "warning");
			return;
		}
	}
	const runKey = activeMissionRunKey(missionCwd, id);
	if (ACTIVE_MISSION_RUNS.has(runKey)) {
		ctx.ui.notify("Mission execution is already active for this mission.", "warning");
		return;
	}
	const lockAcquire = await acquireRunnerLock(missionCwd, mission);
	if (!lockAcquire.ok) {
		ctx.ui.notify(lockAcquire.reason, "warning");
		return;
	}
	if (lockAcquire.recoveredStale) {
		appendEvent(dir, "mission_runner_lock_recovered", { missionId: mission.id, previousOwner: lockAcquire.lock.recoveredFrom, newOwnerPid: process.pid, newOwnerSessionMarker: parentSessionMarker() });
	}
	ACTIVE_MISSION_RUNS.add(runKey);
	const heartbeat = setInterval(() => {
		try {
			upsertRunnerLockHeartbeat(missionCwd, id);
		} catch {
			// Best effort heartbeat persistence.
		}
	}, RUNNER_HEARTBEAT_INTERVAL_MS);
	try {
		if (await gitPorcelain(mission.cwd)) {
			const ok = await ctx.ui.confirm("Dirty git status", "Repository has uncommitted changes. Continue anyway? Workers must leave it clean after each feature.");
			if (!ok) return;
		}
		if (!hasMissionExecutionStarted(missionCwd, mission)) {
			mission = markMissionExecutionStarted(mission);
			saveMission(missionCwd, mission);
			appendEvent(dir, "mission_execution_started", { missionId: mission.id });
		}
		if (hasMissionPauseRequest(missionCwd, mission.id)) {
			clearMissionPauseRequest(missionCwd, mission.id);
			appendEvent(dir, "mission_resume_requested", { missionId: mission.id, source: "runMission" });
		}
		if (mission.status === "paused") {
			transitionMissionResumeFromPause(mission);
			saveMission(missionCwd, mission);
		}
		autoOpenMissionControl(ctx, mission, pi);
		ctx.ui.notify(`Running mission ${mission.title}`, "info");
		const childAbortController = new AbortController();
		const childSignal = childAbortController.signal;
		if (!options.detached && ctx.signal) {
			const abortFromParent = () => childAbortController.abort();
			if (ctx.signal.aborted) abortFromParent();
			else ctx.signal.addEventListener("abort", abortFromParent, { once: true });
		}
		ACTIVE_MISSION_CHILD_ABORTERS.set(runKey, childAbortController);
		const runner = new MissionExecutionRunner(ctx, pi, id, dir, childSignal);
		await runner.run();
	} finally {
		clearInterval(heartbeat);
		releaseRunnerLock(missionCwd, id, "runMission_finished");
		ACTIVE_MISSION_CHILD_ABORTERS.delete(runKey);
		ACTIVE_MISSION_RUNS.delete(runKey);
	}
}

export const __testing = {
	normalizeMissionShape,
	missionForPersistence,
	effectiveMilestoneValidationFailureLimit,
	milestoneValidationFailureCount,
	incrementMilestoneValidationFailureCount,
	saveMission,
	loadMission,
};

export default function missionsExtension(pi: ExtensionAPI): void {
	let orchestratorState: MissionOrchestratorSessionState | undefined;
	let activePlanningId: string | undefined;
	let activeMissionId: string | undefined;
	let activeRunningId: string | undefined;

	const persistOrchestratorState = (cwd: string, mission?: MissionState, overrides: Partial<MissionOrchestratorSessionState> = {}) => {
		const hasOverride = (key: keyof MissionOrchestratorSessionState) => Object.prototype.hasOwnProperty.call(overrides, key);
		orchestratorState = buildOrchestratorState(cwd, mission, {
			...overrides,
			activeMissionId: hasOverride("activeMissionId") ? overrides.activeMissionId : mission?.id ?? activeMissionId,
			activePlanningMissionId: hasOverride("activePlanningMissionId") ? overrides.activePlanningMissionId : activePlanningId,
			activeRunningMissionId: hasOverride("activeRunningMissionId") ? overrides.activeRunningMissionId : activeRunningId,
		});
		activeMissionId = orchestratorState.activeMissionId;
		activePlanningId = orchestratorState.activePlanningMissionId;
		activeRunningId = orchestratorState.activeRunningMissionId;
		pi.appendEntry(ORCHESTRATOR_STATE_ENTRY, orchestratorState);
	};

	pi.registerTool({
		name: "mission_start_execution",
		label: "Start Mission Execution",
		description: "Ask the user for explicit confirmation, then start or resume sequential mission execution on their behalf. Omit missionId to use the current session's active mission.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const missionId = params.missionId || activeMissionId || activePlanningId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
			if (!missionId) {
				return { content: [{ type: "text", text: "No mission found to run." }], details: {}, isError: true };
			}
			const mission = loadMission(ctx.cwd, missionId);
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Explicit confirmation requires an interactive UI." }], details: { missionId }, isError: true };
			}
			const ok = await ctx.ui.confirm("Start mission execution?", `${mission.title}\n\nThis will run mission ${missionId} now. Workers may modify files and create commits.`);
			if (!ok) return { content: [{ type: "text", text: "Mission start canceled by user." }], details: { missionId } };
			activeRunningId = missionId;
			persistOrchestratorState(ctx.cwd, mission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: missionId });
			ensureOfficialOrchestratorSessionRecord(ctx, mission);
			const result = executeRunnerCommand({ command: "start", missionId, source: "mission_start_execution_tool" }, ctx, pi, orchestratorState);
			return { content: [{ type: "text", text: result.text }], details: { missionId }, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "mission_runner_command",
		label: "Mission Runner Command",
		description: "Execute deterministic mission runner commands (start, pause-after-current, resume, retry feature, block/unblock where safe, status, cancel current child when supported).",
		parameters: Type.Object({
			command: Type.Union([
				Type.Literal("start"),
				Type.Literal("pause-after-current"),
				Type.Literal("resume"),
				Type.Literal("retry-feature"),
				Type.Literal("block"),
				Type.Literal("unblock"),
				Type.Literal("status"),
				Type.Literal("cancel-current-child"),
			]),
			missionId: Type.Optional(Type.String()),
			featureId: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = params.command as RunnerCommandName;
			const missionId = params.missionId || activeMissionId || activePlanningId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
			if (!missionId) return { content: [{ type: "text", text: "No mission found." }], details: {}, isError: true };
			if ((command === "start" || command === "resume" || command === "cancel-current-child") && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					command === "cancel-current-child" ? "Cancel current mission child?" : command === "resume" ? "Resume mission execution?" : "Start mission execution?",
					`Mission ${missionId}\n\nCommand: ${command}. Workers may modify files and create commits.`,
				);
				if (!ok) return { content: [{ type: "text", text: `Mission runner command canceled: ${command}.` }], details: { missionId, command } };
			}
			if (command === "start" || command === "resume") {
				activeRunningId = missionId;
				const mission = loadMission(ctx.cwd, missionId);
				persistOrchestratorState(ctx.cwd, mission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: missionId });
				ensureOfficialOrchestratorSessionRecord(ctx, mission);
			}
			const result = executeRunnerCommand({ command, missionId, featureId: params.featureId, reason: params.reason, source: "mission_runner_command_tool" }, ctx, pi, orchestratorState);
			if (result.ok && command === "status") ctx.ui.notify(result.text, "info");
			else ctx.ui.notify(result.text, result.ok ? "info" : "warning");
			return { content: [{ type: "text", text: result.text }], details: { missionId, command, ...(result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {}) }, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "mission_write_plan",
		label: "Write or Revise Mission Plan",
		description: "Persist the current interactive mission planning draft or revise the active mission plan. Omit missionId to use the current session's active planning/running mission; never-started missions are not run, but previously-started blocked missions auto-resume when a revision leaves pending runnable work.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
			mission: Type.Any({ description: "Complete mission.json object matching the mission-orchestrator schema." }),
			objectiveMd: Type.String({ description: "Human-readable objective, constraints, non-goals, and assumptions." }),
			featuresJson: Type.Any({ description: "Ordered feature list derived from milestone features." }),
			validationContractJson: Type.Any({ description: "Implementation-independent validation assertions." }),
			validationContractMd: Type.String({ description: "Human-readable validation contract." }),
			workerSkillMd: Type.String({ description: "Mission-specific worker SKILL.md content." }),
			validatorScrutinySkillMd: Type.String({ description: "Mission-specific scrutiny validator SKILL.md content." }),
			validatorUserTestingSkillMd: Type.Optional(Type.String({ description: "Mission-specific QA/user-testing validator SKILL.md content, if applicable." })),
			reviewerSkillMd: Type.Optional(Type.String({ description: "Mission-specific read-only reviewer SKILL.md content, if applicable." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = activeMissionFromState(ctx.cwd, orchestratorState);
			const requestedMission = params.mission as Partial<MissionState>;
			const explicitMissionId = params.missionId || requestedMission.id;
			const activeCandidateId = activePlanningId || activeMissionId || active?.id;
			let missionId = explicitMissionId || activeCandidateId || createPlanningMission(ctx.cwd).id;
			if (!explicitMissionId && activeCandidateId) {
				try {
					const candidate = loadMission(ctx.cwd, activeCandidateId);
					if (candidate.status === "complete" || candidate.status === "failed") missionId = createPlanningMission(ctx.cwd).id;
				} catch {
					// Ignore missing candidate and continue with generated/new id.
				}
			}
			const dir = missionDir(ctx.cwd, missionId);
			const existingMission = fs.existsSync(path.join(dir, "mission.json")) ? loadMission(ctx.cwd, missionId) : undefined;
			const seedMission = existingMission ?? createPlanningMission(ctx.cwd, missionId);
			ensureDir(path.join(dir, "plan"));
			ensureDir(path.join(dir, "skills/worker"));
			ensureDir(path.join(dir, "skills/validator-scrutiny"));
			ensureDir(path.join(dir, "skills/validator-user-testing"));
			ensureDir(path.join(dir, "skills/reviewer"));
			const mission = normalizeMissionShape(params.mission as MissionState);
			mission.id = missionId;
			mission.cwd = existingMission?.cwd || (typeof requestedMission.cwd === "string" && requestedMission.cwd.trim() ? requestedMission.cwd.trim() : ctx.cwd);
			mission.schemaVersion = 1;
			mission.status = persistedPlanStatus(mission.status, existingMission);
			mission.updatedAt = nowIso();
			if (!mission.createdAt) mission.createdAt = seedMission.createdAt;
			mission.models = normalizeRoleModels(mission.models ?? seedMission.models);
			if (
				existingMission &&
				mission.status !== "planned" &&
				mission.status !== "planning" &&
				!mission.executionStartedAt &&
				hasMissionExecutionStarted(ctx.cwd, existingMission)
			) mission.executionStartedAt = existingMission.executionStartedAt ?? nowIso();
			if (!existingMission) {
				const globalModels = readMissionGlobalSettings(ctx.cwd).models;
				for (const role of MISSION_ROLES) if (mission.models[role] === "default") mission.models[role] = globalModels[role];
			}
			writeJson(path.join(dir, "mission.json"), missionForPersistence(mission));
			fs.writeFileSync(path.join(dir, "plan/objective.md"), params.objectiveMd);
			writeJson(path.join(dir, "plan/features.json"), missionFeatureList(mission).length > 0 ? missionFeatureList(mission) : params.featuresJson);
			writeJson(path.join(dir, "plan/validation-contract.json"), params.validationContractJson);
			fs.writeFileSync(path.join(dir, "plan/validation-contract.md"), params.validationContractMd);
			fs.writeFileSync(path.join(dir, "skills/worker/SKILL.md"), params.workerSkillMd);
			fs.writeFileSync(path.join(dir, "skills/validator-scrutiny/SKILL.md"), params.validatorScrutinySkillMd);
			if (params.validatorUserTestingSkillMd) fs.writeFileSync(path.join(dir, "skills/validator-user-testing/SKILL.md"), params.validatorUserTestingSkillMd);
			if (params.reviewerSkillMd) fs.writeFileSync(path.join(dir, "skills/reviewer/SKILL.md"), params.reviewerSkillMd);
			const autoResume = shouldAutoResumeAfterPlanRevision(ctx.cwd, existingMission, mission);
			appendEvent(dir, existingMission ? "interactive_plan_revised" : "interactive_plan_written", { title: mission.title, features: missionFeatureList(mission).length, status: mission.status, autoResume });
			updateWidget(ctx, mission);
			persistOrchestratorState(ctx.cwd, mission, {
				activeMissionId: missionId,
				activePlanningMissionId: mission.status === "planning" ? missionId : undefined,
				activeRunningMissionId: autoResume || mission.status === "running" || mission.status === "paused" ? missionId : undefined,
			});
			ensureOfficialOrchestratorSessionRecord(ctx, mission);
			let text = persistedPlanSummary(mission, dir, params.objectiveMd, params.validationContractJson, Boolean(existingMission));
			if (autoResume) {
				ctx.ui.notify(`Recovery plan saved; auto-resuming mission ${missionId}.`, "info");
				appendEvent(dir, "mission_auto_resume_after_plan_revision", { missionId });
				activeRunningId = missionId;
				const result = executeRunnerCommand({ command: "resume", missionId, source: "plan_revision_auto_resume" }, ctx, pi, orchestratorState);
				text = `${text}\n\n${result.text}`;
			}
			return { content: [{ type: "text", text }], details: { missionId, dir, autoResumed: autoResume } };
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const content = lightweightMissionContext(ctx.cwd, orchestratorState);
		if (!content) return;
		return {
			message: {
				customType: "missions-orchestrator-context",
				display: false,
				content,
			},
		};
	});

	const handleMissions = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<MissionCommandResult> => {
		const [subcommand, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
		const args = rest.join(" ");
		try {
			if (!subcommand || subcommand === "new" || !["status", "run", "resume", "list", "clear", "models"].includes(subcommand)) {
				const goal = subcommand === "new" ? args : rawArgs.trim();
				await startMissionOrchestrator(goal, ctx, pi);
				return { ok: true, text: "Mission orchestrator loaded." };
			}
			if (subcommand === "models") {
				const modelArgs = args.split(/\s+/).filter(Boolean);
				if (modelArgs[0] === "set") modelArgs.shift();
				const [roleArg, ...modelParts] = modelArgs;
				if (!roleArg) {
					const text = formatGlobalModels(ctx.cwd);
					ctx.ui.notify(text, "info");
					return { ok: true, text, details: { settingsFile: globalSettingsFile(ctx.cwd), models: readMissionGlobalSettings(ctx.cwd).models } };
				}
				if (!isMissionRole(roleArg)) {
					const text = `Unknown mission model role '${roleArg}'. Expected one of: ${MISSION_ROLES.join(", ")}.`;
					ctx.ui.notify(text, "warning");
					return { ok: false, text };
				}
				const model = modelParts.join(" ").trim();
				if (!model) {
					const current = readMissionGlobalSettings(ctx.cwd).models[roleArg];
					const text = `${roleArg}: ${current}\n\nSet with: /missions models ${roleArg} <model> (or /missions models set ${roleArg} <model>)`;
					ctx.ui.notify(text, "info");
					return { ok: true, text, details: { role: roleArg, model: current } };
				}
				const text = setGlobalModel(ctx.cwd, roleArg, model);
				ctx.ui.notify(text, "info");
				return { ok: true, text, details: { settingsFile: globalSettingsFile(ctx.cwd), models: readMissionGlobalSettings(ctx.cwd).models } };
			}
			if (subcommand === "status") {
				const mission = resolveMission(ctx.cwd, args || undefined, orchestratorState);
				if (!mission) {
					ctx.ui.notify("No missions found.", "info");
					return { ok: false, text: "No missions found." };
				}
				updateWidget(ctx, mission);
				const text = summarizeMission(mission);
				ctx.ui.notify(text, "info");
				return { ok: true, text, details: { missionId: mission.id } };
			}
			if (subcommand === "run" || subcommand === "resume") {
				const id = args || activeMissionId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
				if (!id) return { ok: false, text: "No mission found to run." };
				activeRunningId = id;
				const mission = loadMission(ctx.cwd, id);
				persistOrchestratorState(ctx.cwd, mission, { activeMissionId: id, activePlanningMissionId: undefined, activeRunningMissionId: id });
				ensureOfficialOrchestratorSessionRecord(ctx, mission);
				return executeRunnerCommand({ command: subcommand === "resume" ? "resume" : "start", missionId: id, source: `missions_${subcommand}_command` }, ctx, pi, orchestratorState);
			}
			if (subcommand === "list") {
				const text = missionListText(ctx.cwd);
				ctx.ui.notify(text, "info");
				return { ok: true, text };
			}
			if (subcommand === "clear") {
				const completedCount = listMissions(ctx.cwd).filter((mission) => mission.status === "complete" && !isMissionCleared(ctx.cwd, mission.id)).length;
				if (completedCount > 0) {
					const ok = await ctx.ui.confirm("Clear completed missions?", `This will hide ${completedCount} completed mission${completedCount === 1 ? "" : "s"} from default mission UI. Artifacts will not be deleted and statuses will remain complete.`);
					if (!ok) {
						const text = "Mission clear canceled by user.";
						ctx.ui.notify(text, "info");
						return { ok: true, text, details: { clearedIds: [] } };
					}
				}
				const result = clearCompletedMissions(ctx.cwd);
				ctx.ui.notify(result.text, result.clearedIds.length > 0 ? "info" : "warning");
				updateWidget(ctx, activeMissionFromState(ctx.cwd, orchestratorState) ?? latestVisibleMission(ctx.cwd));
				return { ok: true, text: result.text, details: result };
			}
			const usage = "Usage: /missions [goal] | /missions new [goal] | /missions run|resume [id] | /missions status [id] | /missions list | /missions clear | /missions models [set] [role] [model]";
			ctx.ui.notify(usage, "warning");
			return { ok: false, text: usage };
		} catch (error) {
			const text = `missions error: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(text, "error");
			return { ok: false, text };
		}
	};

	pi.registerTool({
		name: "mission_status",
		label: "Show Mission Status",
		description: "Show mission status on the user's behalf. Read-only; no confirmation required. Omit missionId to use the current session's active mission, with the same summary semantics as /missions status.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mission = resolveMission(ctx.cwd, params.missionId, orchestratorState);
			if (!mission) return { content: [{ type: "text", text: "No missions found." }], details: {}, isError: true };
			updateWidget(ctx, mission);
			const text = summarizeMission(mission);
			ctx.ui.notify(text, "info");
			return { content: [{ type: "text", text }], details: { missionId: mission.id } };
		},
	});

	pi.registerTool({
		name: "mission_list",
		label: "List Missions",
		description: "List missions on the user's behalf. Read-only; no confirmation required. Uses the same listing semantics as /missions list.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const text = missionListText(ctx.cwd);
			ctx.ui.notify(text, "info");
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "mission_clear_completed",
		label: "Clear Completed Missions",
		description: "Ask for explicit confirmation, then clear completed missions on the user's behalf using the same backing behavior as /missions clear.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Explicit confirmation requires an interactive UI." }], details: {}, isError: true };
			}
			const completedCount = listMissions(ctx.cwd).filter((mission) => mission.status === "complete" && !isMissionCleared(ctx.cwd, mission.id)).length;
			const ok = await ctx.ui.confirm("Clear completed missions?", `This will hide ${completedCount} completed mission${completedCount === 1 ? "" : "s"} from default mission UI. Artifacts will not be deleted and statuses will remain complete.`);
			if (!ok) return { content: [{ type: "text", text: "Mission clear canceled by user." }], details: { clearedIds: [] } };
			try {
				const result = clearCompletedMissions(ctx.cwd);
				ctx.ui.notify(result.text, result.clearedIds.length > 0 ? "info" : "warning");
				updateWidget(ctx, activeMissionFromState(ctx.cwd, orchestratorState) ?? latestVisibleMission(ctx.cwd));
				return { content: [{ type: "text", text: result.text }], details: result };
			} catch (error) {
				const text = `missions clear failed: ${error instanceof Error ? error.message : String(error)}`;
				ctx.ui.notify(text, "error");
				return { content: [{ type: "text", text }], details: {}, isError: true };
			}
		},
	});

	pi.registerCommand("missions", {
		description: "Plan and run long sequential missions (/missions [goal]|run|status|list|clear|models)",
		handler: async (args, ctx) => { await handleMissions(args, ctx); },
	});

	pi.registerCommand("mission-control", {
		description: "Open read-only Mission Control overview and detail overlay",
		handler: async (args, ctx) => {
			const targetMissionId = args.trim() || undefined;
			await openMissionControl(ctx, orchestratorState, targetMissionId, pi);
		},
	});

	pi.registerCommand("mission-orchestrator", {
		description: "Open a dedicated orchestrator chat session for a running/active mission",
		handler: async (args, ctx) => {
			const mission = resolveMission(ctx.cwd, args.trim() || undefined, orchestratorState);
			if (!mission) {
				ctx.ui.notify("No mission found for orchestrator session.", "warning");
				return;
			}
			await openOrSwitchMissionOrchestratorSession(ctx, mission);
		},
	});

	pi.registerCommand("mission", {
		description: "Alias for /missions",
		handler: async (args, ctx) => { await handleMissions(args, ctx); },
	});

	pi.on("session_start", async (_event, ctx) => {
		orchestratorState = latestOrchestratorStateFromSession(ctx.cwd, ctx.sessionManager.getEntries());
		const active = activeMissionFromState(ctx.cwd, orchestratorState);
		if (!orchestratorState && active) orchestratorState = buildOrchestratorState(ctx.cwd, active);
		activeMissionId = active?.id ?? orchestratorState?.activeMissionId;
		activePlanningId = active?.status === "planning" ? active.id : orchestratorState?.activePlanningMissionId;
		activeRunningId = active?.status === "running" || active?.status === "paused" ? active.id : orchestratorState?.activeRunningMissionId;
		if (active && (!orchestratorState?.context || orchestratorState.context.id !== active.id || orchestratorState.context.status !== active.status)) {
			persistOrchestratorState(ctx.cwd, active, { activeMissionId: active.id, activePlanningMissionId: activePlanningId, activeRunningMissionId: activeRunningId });
		}
		if (active) ensureOfficialOrchestratorSessionRecord(ctx, active);
		updateWidget(ctx, active ?? latestVisibleMission(ctx.cwd));
	});
}
