import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourceFile = path.join(repoRoot, "extensions", "missions", "index.ts");
const source = fs.readFileSync(sourceFile, "utf8");

const checks = [
	{
		id: "MISSION_WRITE_PLAN_AUTO_RESUME_USES_RUNNER_COMMAND",
		ok: source.includes('executeRunnerCommand({ command: "resume", missionId, source: "plan_revision_auto_resume" }, ctx, pi, orchestratorState)'),
		error: "mission_write_plan auto-resume must route through executeRunnerCommand(resume).",
	},
	{
		id: "NO_DIRECT_START_IN_PLAN_AUTO_RESUME",
		ok: !source.includes('startMissionInBackground(missionId, ctx, pi, "plan_revision_auto_resume")'),
		error: "mission_write_plan auto-resume must not call startMissionInBackground directly.",
	},
];

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
	console.error("F3 routing validation failed:");
	for (const check of failed) console.error(`- [${check.id}] ${check.error}`);
	process.exit(1);
}

console.log("F3 routing validation passed.");
for (const check of checks) console.log(`- [${check.id}] ok`);
