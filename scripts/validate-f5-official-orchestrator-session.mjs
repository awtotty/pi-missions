import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourceFile = path.join(repoRoot, "extensions", "missions", "index.ts");
const source = fs.readFileSync(sourceFile, "utf8");

const checks = [
	{
		id: "OFFICIAL_ORCHESTRATOR_RECORD_FILE",
		ok: source.includes('"orchestrator-session.json"'),
		error: "Official orchestrator session record file must be persisted at mission/orchestrator-session.json.",
	},
	{
		id: "MISSION_ORCHESTRATOR_REUSES_OFFICIAL_SESSION",
		ok: source.includes("if (existing?.sessionPath && fs.existsSync(existing.sessionPath))") && source.includes("ctx.switchSession(existing.sessionPath"),
		error: "/mission-orchestrator must switch to the official orchestrator session when available.",
	},
	{
		id: "ACTIVE_MISSION_ENSURES_OFFICIAL_RECORD",
		ok: source.includes("ensureOfficialOrchestratorSessionRecord(ctx, mission);") && source.includes("if (active) ensureOfficialOrchestratorSessionRecord(ctx, active);"),
		error: "Active missions must ensure a durable official orchestrator session record.",
	},
];

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
	console.error("F5 official orchestrator session validation failed:");
	for (const check of failed) console.error(`- [${check.id}] ${check.error}`);
	process.exit(1);
}

console.log("F5 official orchestrator session validation passed.");
for (const check of checks) console.log(`- [${check.id}] ok`);
