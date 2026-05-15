import * as fs from "node:fs";
import * as path from "node:path";
import { missionDir, nowIso, parentSessionMarker, readJson, writeJson } from "../runtime-core.js";
import type { MissionRunnerLockArtifact, MissionState } from "../runtime-types.js";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNNER_HEARTBEAT_TIMEOUT_MS = 20_000;
const RUNNER_LOCK_GUARD_TIMEOUT_MS = 30_000;
const RUNNER_LOCK_GUARD_WAIT_MS = 2_000;
const RUNNER_LOCK_GUARD_RETRY_DELAY_MS = 50;

const EXECUTION_STARTED_EVENT_TYPES = new Set(["mission_execution_started", "worker_started", "validator_started", "mission_block_recorded", "mission_complete"]);

export function runnerLockFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "runner-lock.json");
}

function runnerLockGuardDir(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "runner-lock.guard");
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPidAlive(pid: number): boolean | undefined {
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

export function readRunnerLock(cwd: string, missionId: string): MissionRunnerLockArtifact | undefined {
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

export function lockHeartbeatExpired(lock: MissionRunnerLockArtifact): boolean {
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

export function upsertRunnerLockHeartbeat(cwd: string, missionId: string): void {
	const existing = readRunnerLock(cwd, missionId);
	if (!existing || !isSameLockOwner(existing) || existing.status !== "active") return;
	existing.heartbeatAt = nowIso();
	writeRunnerLock(cwd, missionId, existing);
}

export function releaseRunnerLock(cwd: string, missionId: string, reason: string): void {
	const existing = readRunnerLock(cwd, missionId);
	if (!existing || !isSameLockOwner(existing)) return;
	existing.status = "released";
	existing.releasedAt = nowIso();
	existing.releasedReason = reason;
	existing.heartbeatAt = existing.releasedAt;
	writeRunnerLock(cwd, missionId, existing);
}

export async function acquireRunnerLock(cwd: string, mission: MissionState): Promise<{ ok: true; lock: MissionRunnerLockArtifact; recoveredStale: boolean } | { ok: false; reason: string; lock?: MissionRunnerLockArtifact }> {
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

export function hasMissionExecutionStarted(cwd: string, mission: MissionState): boolean {
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
