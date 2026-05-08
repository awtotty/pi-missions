import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLE_MODELS, MISSION_ROLES, type MissionRole, type MissionRoleModels } from "./runtime-types.js";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "../..");

export const BASE_SKILLS = {
	orchestrator: path.join(PACKAGE_ROOT, "skills/mission-orchestrator/SKILL.md"),
	worker: path.join(PACKAGE_ROOT, "skills/mission-worker/SKILL.md"),
	validator: path.join(PACKAGE_ROOT, "skills/mission-validator/SKILL.md"),
	reviewer: path.join(PACKAGE_ROOT, "skills/mission-reviewer/SKILL.md"),
};

export function nowIso(): string {
	return new Date().toISOString();
}

export function normalizeRoleModels(models?: Partial<Record<MissionRole, unknown>>): MissionRoleModels {
	const normalized = { ...DEFAULT_ROLE_MODELS };
	for (const role of MISSION_ROLES) {
		const value = models?.[role];
		if (typeof value === "string" && value.trim()) normalized[role] = value.trim();
	}
	return normalized;
}

export function isMissionRole(value: string): value is MissionRole {
	return (MISSION_ROLES as string[]).includes(value);
}

export function missionRoot(cwd: string): string {
	return path.join(cwd, ".pi", "missions");
}

export function missionDir(cwd: string, id: string): string {
	return path.join(missionRoot(cwd), id);
}

export function clearedMissionsFile(cwd: string): string {
	return path.join(missionRoot(cwd), "cleared.json");
}

export function globalSettingsFile(cwd: string): string {
	return path.join(missionRoot(cwd), "settings.json");
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendEvent(dir: string, type: string, data: unknown): void {
	fs.appendFileSync(path.join(dir, "event-log.jsonl"), `${JSON.stringify({ ts: nowIso(), type, data })}\n`);
}

export function parentSessionMarker(): string {
	const marker = process.env.PI_SESSION_ID || process.env.PI_RUN_SESSION || process.env.TMUX || process.env.SSH_TTY;
	return marker && marker.trim() ? marker.trim() : `pid-${process.pid}`;
}
