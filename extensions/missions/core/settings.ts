import * as fs from "node:fs";
import { DEFAULT_ROLE_MODELS, MISSION_ROLES, type MissionGlobalSettings, type MissionRole, type MissionRoleModels } from "../runtime-types.js";
import { readJson, writeJson } from "./json.js";
import { globalSettingsFile } from "./paths.js";
import { nowIso } from "./events.js";

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

export function readMissionGlobalSettings(cwd: string): MissionGlobalSettings {
	const file = globalSettingsFile(cwd);
	if (!fs.existsSync(file)) return { schemaVersion: 1, updatedAt: nowIso(), models: { ...DEFAULT_ROLE_MODELS } };
	const parsed = readJson<Partial<MissionGlobalSettings>>(file);
	return {
		schemaVersion: 1,
		updatedAt: parsed.updatedAt || nowIso(),
		models: normalizeRoleModels(parsed.models),
	};
}

export function writeMissionGlobalSettings(cwd: string, settings: MissionGlobalSettings): void {
	writeJson(globalSettingsFile(cwd), { schemaVersion: 1, updatedAt: nowIso(), models: normalizeRoleModels(settings.models) });
}

export function formatGlobalModels(cwd: string): string {
	const settings = readMissionGlobalSettings(cwd);
	return [
		"Global mission role model defaults:",
		...MISSION_ROLES.map((role) => `- ${role}: ${settings.models[role]}`),
		`Settings file: ${globalSettingsFile(cwd)}`,
		"",
		"Set with: /missions models <role> <model> (or /missions models set <role> <model>)",
		"Use 'default' to inherit pi's default model for a role.",
	].join("\n");
}

export function setGlobalModel(cwd: string, role: MissionRole, model: string): string {
	const settings = readMissionGlobalSettings(cwd);
	settings.models[role] = model.trim() || "default";
	writeMissionGlobalSettings(cwd, settings);
	return formatGlobalModels(cwd);
}
