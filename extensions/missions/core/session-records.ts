import * as fs from "node:fs";
import * as path from "node:path";
import { missionDir, nowIso, readJson, writeJson } from "../runtime-core.js";
import type {
	MissionChildSessionRecord,
	MissionChildSessionRegistry,
	MissionOrchestratorSessionRecord,
	MissionRunContext,
	MissionValidatorMode,
} from "../runtime-types.js";

export function orchestratorSessionRecordFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "orchestrator-session.json");
}

export function childSessionRegistryFile(cwd: string, missionId: string): string {
	return path.join(missionDir(cwd, missionId), "child-sessions.json");
}

export function readChildSessionRegistry(cwd: string, missionId: string): MissionChildSessionRegistry {
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

export function writeChildSessionRegistry(cwd: string, missionId: string, records: MissionChildSessionRecord[]): void {
	writeJson(childSessionRegistryFile(cwd, missionId), { schemaVersion: 1, updatedAt: nowIso(), records });
}

export function parseRunOwnershipSessionId(runDir: string): string | undefined {
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

export function parseTranscriptSessionIdentity(transcriptFile: string): { sessionId?: string; sessionPath?: string } {
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

export function nextChildAttemptNumber(cwd: string, missionId: string, role: "worker" | "validator", featureId: string | undefined, validatorMode?: MissionValidatorMode): number {
	const registry = readChildSessionRegistry(cwd, missionId);
	return registry.records.filter((record) => record.role === role && record.featureId === featureId && (!validatorMode || record.validatorMode === validatorMode)).length + 1;
}

export function upsertChildSessionRecord(cwd: string, missionId: string, record: MissionChildSessionRecord): void {
	const registry = readChildSessionRegistry(cwd, missionId);
	const next = registry.records.filter((item) => item.runId !== record.runId);
	next.push(record);
	writeChildSessionRegistry(cwd, missionId, next.sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
}

export function childSessionRecordForRun(run: MissionRunContext): MissionChildSessionRecord | undefined {
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

export function readOrchestratorSessionRecord(cwd: string, missionId: string): MissionOrchestratorSessionRecord | undefined {
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

export function writeOrchestratorSessionRecord(cwd: string, missionId: string, value: Omit<MissionOrchestratorSessionRecord, "schemaVersion" | "missionId">): MissionOrchestratorSessionRecord {
	const record: MissionOrchestratorSessionRecord = { schemaVersion: 1, missionId, ...value };
	writeJson(orchestratorSessionRecordFile(cwd, missionId), record);
	return record;
}
