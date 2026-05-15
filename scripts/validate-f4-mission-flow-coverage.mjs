import fs from "node:fs";

function fail(message) {
	throw new Error(message);
}

function assertIncludes(haystack, needle, message) {
	if (!haystack.includes(needle)) fail(message);
}

const indexSource = fs.readFileSync(new URL("../extensions/missions/index.ts", import.meta.url), "utf8");
const runtimeSource = fs.readFileSync(new URL("../extensions/missions/runtime-extension.ts", import.meta.url), "utf8");
const runtimeTypesSource = fs.readFileSync(new URL("../extensions/missions/runtime-types.ts", import.meta.url), "utf8");
const manualValidationSource = fs.readFileSync(new URL("../docs/release-validation.md", import.meta.url), "utf8");

// Module split coverage: index.ts should stay bootstrap-only.
assertIncludes(indexSource, 'import missionsExtension from "./runtime-extension.js";', "index.ts must import runtime-extension bootstrap module.");
assertIncludes(indexSource, "export default missionsExtension;", "index.ts must export runtime-extension bootstrap module.");
if (indexSource.split("\n").filter((line) => line.trim()).length > 3) fail("index.ts should remain minimal bootstrap glue after runtime split.");

// Artifact schema failure handling coverage.
for (const token of [
	'validateMissionArtifact("worker-handoff", parsed)',
	'validateMissionArtifact("scrutiny-validation-report", parsed)',
	'validateMissionArtifact("user-testing-report", parsed)',
	'artifactValidationErrorSummary("worker-handoff", validation.issues)',
	'artifactValidationErrorSummary("scrutiny-validation-report", validation.issues)',
	'artifactValidationErrorSummary("user-testing-report", validation.issues)',
	'ensureValidatorFailureReportArtifacts(runDir, milestone, result, report, reportSchemaError)',
	'ensureUserTestingFailureReportArtifacts(runDir, { id: milestone.id, title: milestone.title, label: "Milestone" }, result, report, reportSchemaError)',
]) {
	assertIncludes(runtimeSource, token, `missing artifact-schema coverage token: ${token}`);
}

// Milestone-boundary user-testing skip/pass/fail behavior.
for (const token of [
	"function isMilestoneUserTestingRequired(milestone: MissionMilestone): boolean",
	"function milestoneAwaitingUserTestingValidation(milestone: MissionMilestone): boolean",
	"async function runMilestoneUserTestingValidator",
	"systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, \"skills/validator-user-testing/SKILL.md\")]",
	"if (result.exitCode === 0 && report?.status === \"pass\") milestone.status = \"complete\";",
	"validatorMode: \"user-testing\"",
]) {
	assertIncludes(runtimeSource, token, `missing milestone user-testing flow token: ${token}`);
}

// Scrutiny validators own code-review/advisory assessment; no standalone reviewer fanout remains.
for (const forbidden of [
	"runReviewerFanout",
	"findFeatureAwaitingReviewers",
	"Act as a read-only mission reviewer",
	"reviewerEvidenceContext(mission, targetFeature)",
]) {
	if (runtimeSource.includes(forbidden)) fail(`standalone reviewer execution path remains: ${forbidden}`);
}

for (const forbidden of ["user-testing-validator"]) {
	if (`${runtimeSource}\n${runtimeTypesSource}`.includes(forbidden)) fail(`validator mode modeled as standalone role/run kind: ${forbidden}`);
}
for (const token of [
	'type MissionRunKind = "worker" | "validator"',
	'type MissionValidatorMode = "scrutiny" | "user-testing"',
	'validatorMode?: MissionValidatorMode',
	'role: "worker" | "validator"',
	'role: "validator",\n\t\tvalidatorMode: "user-testing"',
]) {
	assertIncludes(`${runtimeSource}\n${runtimeTypesSource}`, token, `missing three-role validator-mode token: ${token}`);
}

// Existing command/tool behavior preservation.
for (const token of [
	'name: "mission_start_execution"',
	'name: "mission_runner_command"',
	'if (input.command === "start" || input.command === "resume")',
	'if (input.command === "pause-after-current")',
	'if (input.command === "cancel-current-child")',
	'if (input.command === "retry-feature")',
	'if (input.command === "block")',
	'if (input.command === "unblock")',
]) {
	assertIncludes(runtimeSource, token, `missing command/tool compatibility token: ${token}`);
}

// Documentation/manual validation coverage for this flow.
for (const token of [
	"### New mission flow: schemas, optional user-testing, and scrutiny-owned code review",
	"Confirm `extensions/missions/index.ts` remains runtime bootstrap glue",
	"Corrupt one of `handoff.json`, `validation-report.json`, or `user-testing-report.json`",
	"Confirm scrutiny pass with `userTesting.required: false` marks the feature complete (user-testing is skipped).",
	"Confirm user-testing `pass` marks feature complete; `fail` or `inconclusive` blocks the mission",
	"scrutiny validators own code review without standalone reviewer fanout.",
	"Verify existing mission controls still behave the same",
	"Integrated Mission Control orchestrator-chat shortcut tuning (including the `o` shortcut) is intentionally deferred",
]) {
	assertIncludes(manualValidationSource, token, `missing release-validation/manual coverage token: ${token}`);
}

console.log("F4 mission-flow coverage checks passed.");
