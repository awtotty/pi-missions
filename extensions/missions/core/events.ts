import * as fs from "node:fs";
import * as path from "node:path";

export function nowIso(): string {
	return new Date().toISOString();
}

export function appendEvent(dir: string, type: string, data: unknown): void {
	fs.appendFileSync(path.join(dir, "event-log.jsonl"), `${JSON.stringify({ ts: nowIso(), type, data })}\n`);
}

export function parentSessionMarker(): string {
	const marker = process.env.PI_SESSION_ID || process.env.PI_RUN_SESSION || process.env.TMUX || process.env.SSH_TTY;
	return marker && marker.trim() ? marker.trim() : `pid-${process.pid}`;
}
