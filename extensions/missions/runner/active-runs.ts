export const ACTIVE_MISSION_RUNS = new Set<string>();
export const ACTIVE_MISSION_CHILD_ABORTERS = new Map<string, AbortController>();

export function activeMissionRunKey(cwd: string, missionId: string): string {
	return `${cwd}\u0000${missionId}`;
}

export function isMissionRunActive(cwd: string, missionId: string): boolean {
	return ACTIVE_MISSION_RUNS.has(activeMissionRunKey(cwd, missionId));
}

export function activeMissionChildAbortController(cwd: string, missionId: string): AbortController | undefined {
	return ACTIVE_MISSION_CHILD_ABORTERS.get(activeMissionRunKey(cwd, missionId));
}

export function tryCancelCurrentChild(cwd: string, missionId: string): boolean {
	const controller = activeMissionChildAbortController(cwd, missionId);
	if (!controller || controller.signal.aborted) return false;
	controller.abort();
	return true;
}
