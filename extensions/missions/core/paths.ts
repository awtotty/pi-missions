import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "../../..");

export const BASE_SKILLS = {
	orchestrator: path.join(PACKAGE_ROOT, "skills/mission-orchestrator/SKILL.md"),
	worker: path.join(PACKAGE_ROOT, "skills/mission-worker/SKILL.md"),
	validator: path.join(PACKAGE_ROOT, "skills/mission-validator/SKILL.md"),
};

export function missionRoot(_cwd: string): string {
	return process.env.PI_MISSIONS_HOME || path.join(os.homedir(), ".pi", "missions");
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
