import { MISSION_RECOVERY_OUTCOMES } from "./runtime-types.js";

type ArtifactKind = "worker-handoff" | "scrutiny-validation-report" | "user-testing-report" | "runtime-orchestrator-recovery-packet";

export interface ArtifactValidationIssue {
	path: string;
	message: string;
}

export interface ArtifactValidationResult<T = Record<string, unknown>> {
	ok: boolean;
	value?: T;
	issues: ArtifactValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(issues: ArtifactValidationIssue[], path: string, message: string): void {
	issues.push({ path, message });
}

function expectString(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false, basePath = ""): void {
	const value = obj[key];
	const path = `${basePath}/${key}`;
	if (value === undefined) {
		if (required) addIssue(issues, path, "is required");
		return;
	}
	if (typeof value !== "string" || !value.trim()) addIssue(issues, path, "must be a non-empty string");
}

function expectBoolean(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false, basePath = ""): void {
	const value = obj[key];
	const path = `${basePath}/${key}`;
	if (value === undefined) {
		if (required) addIssue(issues, path, "is required");
		return;
	}
	if (typeof value !== "boolean") addIssue(issues, path, "must be a boolean");
}

function expectStatus(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, allowed: string[], required = true, basePath = ""): void {
	const value = obj[key];
	const path = `${basePath}/${key}`;
	if (value === undefined) {
		if (required) addIssue(issues, path, "is required");
		return;
	}
	if (typeof value !== "string" || !allowed.includes(value)) addIssue(issues, path, `must be one of: ${allowed.join(", ")}`);
}

function expectLiteral(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, expected: string | number | boolean, required = true, basePath = ""): void {
	const value = obj[key];
	const path = `${basePath}/${key}`;
	if (value === undefined) {
		if (required) addIssue(issues, path, "is required");
		return;
	}
	if (value !== expected) addIssue(issues, path, `must be ${String(expected)}`);
}

function expectStringArray(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false, basePath = ""): void {
	const value = obj[key];
	const path = `${basePath}/${key}`;
	if (value === undefined) {
		if (required) addIssue(issues, path, "is required");
		return;
	}
	if (!Array.isArray(value)) {
		addIssue(issues, path, "must be an array");
		return;
	}
	for (let i = 0; i < value.length; i += 1) {
		if (typeof value[i] !== "string") addIssue(issues, `${path}/${i}`, "must be a string");
	}
}

function expectCommandArray(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false): void {
	const value = obj[key];
	if (value === undefined) {
		if (required) addIssue(issues, `/${key}`, "is required");
		return;
	}
	if (!Array.isArray(value)) {
		addIssue(issues, `/${key}`, "must be an array");
		return;
	}
	for (let i = 0; i < value.length; i += 1) {
		const item = value[i];
		if (!isRecord(item)) {
			addIssue(issues, `/${key}/${i}`, "must be an object");
			continue;
		}
		expectString(issues, item, "command", true, `/${key}/${i}`);
		if (item.exitCode !== undefined && typeof item.exitCode !== "number") addIssue(issues, `/${key}/${i}/exitCode`, "must be a number");
		if (item.notes !== undefined && typeof item.notes !== "string") addIssue(issues, `/${key}/${i}/notes`, "must be a string");
	}
}

function expectObjectArray(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false): Array<{ value: Record<string, unknown>; index: number }> | undefined {
	const value = obj[key];
	if (value === undefined) {
		if (required) addIssue(issues, `/${key}`, "is required");
		return undefined;
	}
	if (!Array.isArray(value)) {
		addIssue(issues, `/${key}`, "must be an array");
		return undefined;
	}
	const out: Array<{ value: Record<string, unknown>; index: number }> = [];
	for (let i = 0; i < value.length; i += 1) {
		if (!isRecord(value[i])) {
			addIssue(issues, `/${key}/${i}`, "must be an object");
			continue;
		}
		out.push({ value: value[i], index: i });
	}
	return out;
}

function validateMissionBlockMetadata(issues: ArtifactValidationIssue[], value: unknown, basePath = "/block"): void {
	if (!isRecord(value)) {
		addIssue(issues, basePath, "is required and must be an object");
		return;
	}
	expectLiteral(issues, value, "schemaVersion", 1, true, basePath);
	expectString(issues, value, "timestamp", true, basePath);
	expectStatus(issues, value, "reasonCategory", ["child_exit_nonzero", "missing_handoff", "dirty_worktree", "worker_reported_blocked", "validator_report_failed", "missing_validation_report", "no_runnable_pending_work"], true, basePath);
	expectStatus(issues, value, "kind", ["worker", "validator"], true, basePath);
	expectStatus(issues, value, "validatorMode", ["scrutiny", "user-testing"], false, basePath);
	expectString(issues, value, "failedItemId", true, basePath);
	expectString(issues, value, "failedItemTitle", true, basePath);
	expectString(issues, value, "missionId", true, basePath);
	expectString(issues, value, "milestoneId", true, basePath);
	expectString(issues, value, "featureId", false, basePath);
	expectString(issues, value, "runId", true, basePath);
	expectString(issues, value, "runDir", true, basePath);
	if (typeof value.exitCode !== "number") addIssue(issues, `${basePath}/exitCode`, "must be a number");
	expectString(issues, value, "status", false, basePath);
	expectString(issues, value, "dirty", false, basePath);
	expectStringArray(issues, value, "artifactPaths", true, basePath);
}

function validateRuntimeOrchestratorRecoveryPacket(value: unknown): ArtifactValidationIssue[] {
	const issues: ArtifactValidationIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, "/", "must be a JSON object");
		return issues;
	}
	expectLiteral(issues, value, "schemaVersion", 1);
	expectString(issues, value, "missionId", true);
	expectString(issues, value, "missionTitle", true);
	expectStatus(issues, value, "status", ["orchestrator_action_required"]);
	expectString(issues, value, "createdAt", true);
	validateMissionBlockMetadata(issues, value.block);

	if (!isRecord(value.dispatch)) addIssue(issues, "/dispatch", "is required and must be an object");
	else {
		expectLiteral(issues, value.dispatch, "target", "dedicated-runtime-orchestrator-session", true, "/dispatch");
		expectLiteral(issues, value.dispatch, "trigger", "runner-after-block", true, "/dispatch");
		expectLiteral(issues, value.dispatch, "runnerWritesPacket", true, true, "/dispatch");
		expectLiteral(issues, value.dispatch, "fallback", "main-chat-display-only", true, "/dispatch");
		expectString(issues, value.dispatch, "orchestratorSessionRecordPath", false, "/dispatch");
	}

	if (!isRecord(value.authority)) addIssue(issues, "/authority", "is required and must be an object");
	else {
		expectStringArray(issues, value.authority, "runner", true, "/authority");
		expectStringArray(issues, value.authority, "mainChat", true, "/authority");
		expectLiteral(issues, value.authority, "missionControl", "read-only-observability", true, "/authority");
		if (!isRecord(value.authority.runtimeOrchestrator)) addIssue(issues, "/authority/runtimeOrchestrator", "is required and must be an object");
		else {
			expectLiteral(issues, value.authority.runtimeOrchestrator, "mayUseMissionTools", true, true, "/authority/runtimeOrchestrator");
			expectLiteral(issues, value.authority.runtimeOrchestrator, "mayReviseMissionMetadata", true, true, "/authority/runtimeOrchestrator");
			expectLiteral(issues, value.authority.runtimeOrchestrator, "mayEditRepositoryImplementation", false, true, "/authority/runtimeOrchestrator");
			expectLiteral(issues, value.authority.runtimeOrchestrator, "repositoryEditPolicy", "forbidden-by-default", true, "/authority/runtimeOrchestrator");
		}
	}

	const outcomes = expectObjectArray(issues, value, "allowedOutcomes", true);
	const seenOutcomes = new Set<string>();
	for (let i = 0; outcomes && i < outcomes.length; i += 1) {
		const entry = outcomes[i];
		expectStatus(issues, entry.value, "outcome", MISSION_RECOVERY_OUTCOMES, true, `/allowedOutcomes/${entry.index}`);
		if (typeof entry.value.outcome === "string") seenOutcomes.add(entry.value.outcome);
		expectString(issues, entry.value, "description", true, `/allowedOutcomes/${entry.index}`);
		expectString(issues, entry.value, "safeWhen", true, `/allowedOutcomes/${entry.index}`);
		expectBoolean(issues, entry.value, "requiresHuman", false, `/allowedOutcomes/${entry.index}`);
	}
	for (const outcome of MISSION_RECOVERY_OUTCOMES) {
		if (!seenOutcomes.has(outcome)) addIssue(issues, "/allowedOutcomes", `must include outcome: ${outcome}`);
	}
	expectStringArray(issues, value, "instructions", true);
	return issues;
}

function validateWorkerHandoff(value: unknown): ArtifactValidationIssue[] {
	const issues: ArtifactValidationIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, "/", "must be a JSON object");
		return issues;
	}
	expectString(issues, value, "featureId", true);
	expectStatus(issues, value, "status", ["complete", "blocked", "failed"]);
	expectString(issues, value, "summary", true);
	expectString(issues, value, "commit", true);
	expectStringArray(issues, value, "implemented", true);
	expectStringArray(issues, value, "leftUndone", true);
	expectStringArray(issues, value, "filesChanged", true);
	expectCommandArray(issues, value, "commandsRun", true);
	expectStringArray(issues, value, "issuesDiscovered", true);
	if (!isRecord(value.procedureCompliance)) addIssue(issues, "/procedureCompliance", "is required and must be an object");
	else {
		expectBoolean(issues, value.procedureCompliance, "readMissionContext", true, "/procedureCompliance");
		expectBoolean(issues, value.procedureCompliance, "checkedGitStatusBeforeWork", true, "/procedureCompliance");
		expectBoolean(issues, value.procedureCompliance, "ranRequiredValidation", true, "/procedureCompliance");
		expectBoolean(issues, value.procedureCompliance, "committedChanges", true, "/procedureCompliance");
		expectBoolean(issues, value.procedureCompliance, "updatedHandoff", true, "/procedureCompliance");
	}
	expectStringArray(issues, value, "risks", true);
	return issues;
}

function validateScrutinyValidationReport(value: unknown): ArtifactValidationIssue[] {
	const issues: ArtifactValidationIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, "/", "must be a JSON object");
		return issues;
	}
	expectStatus(issues, value, "status", ["pass", "fail", "inconclusive"]);
	expectString(issues, value, "summary", true);
	expectString(issues, value, "featureId");
	expectCommandArray(issues, value, "commandsRun", true);
	const assertions = expectObjectArray(issues, value, "assertions", true);
	const defects = expectObjectArray(issues, value, "defects", true);
	const procedureFindings = expectObjectArray(issues, value, "procedureFindings", true);
	expectStatus(issues, value, "recommendation", ["accept", "fix", "replan", "ask-user"]);
	for (let i = 0; assertions && i < assertions.length; i += 1) {
		const entry = assertions[i];
		expectString(issues, entry.value, "assertionId", true, `/assertions/${entry.index}`);
		expectStatus(issues, entry.value, "status", ["pass", "fail", "inconclusive"], true, `/assertions/${entry.index}`);
		expectString(issues, entry.value, "evidence", true, `/assertions/${entry.index}`);
	}
	for (let i = 0; defects && i < defects.length; i += 1) {
		const entry = defects[i];
		expectString(issues, entry.value, "id", true, `/defects/${entry.index}`);
		expectStatus(issues, entry.value, "severity", ["critical", "major", "minor"], true, `/defects/${entry.index}`);
		expectString(issues, entry.value, "title", true, `/defects/${entry.index}`);
		expectString(issues, entry.value, "description", true, `/defects/${entry.index}`);
		expectString(issues, entry.value, "reproduction", true, `/defects/${entry.index}`);
		if (entry.value.suggestedFix !== undefined && typeof entry.value.suggestedFix !== "string") addIssue(issues, `/defects/${entry.index}/suggestedFix`, "must be a string");
	}
	for (let i = 0; procedureFindings && i < procedureFindings.length; i += 1) {
		const entry = procedureFindings[i];
		expectString(issues, entry.value, "id", true, `/procedureFindings/${entry.index}`);
		expectStatus(issues, entry.value, "severity", ["critical", "major", "minor"], true, `/procedureFindings/${entry.index}`);
		expectString(issues, entry.value, "title", true, `/procedureFindings/${entry.index}`);
		expectString(issues, entry.value, "description", true, `/procedureFindings/${entry.index}`);
		expectString(issues, entry.value, "evidence", true, `/procedureFindings/${entry.index}`);
	}
	return issues;
}

function validateUserTestingReport(value: unknown): ArtifactValidationIssue[] {
	const issues: ArtifactValidationIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, "/", "must be a JSON object");
		return issues;
	}
	expectStatus(issues, value, "status", ["pass", "fail", "inconclusive"]);
	expectString(issues, value, "summary", true);
	expectString(issues, value, "featureId", true);
	expectCommandArray(issues, value, "commandsRun", true);
	return issues;
}

export function validateMissionArtifact<T = Record<string, unknown>>(kind: ArtifactKind, value: unknown): ArtifactValidationResult<T> {
	const issues = kind === "worker-handoff"
		? validateWorkerHandoff(value)
		: kind === "scrutiny-validation-report"
			? validateScrutinyValidationReport(value)
			: kind === "user-testing-report"
				? validateUserTestingReport(value)
				: validateRuntimeOrchestratorRecoveryPacket(value);
	return { ok: issues.length === 0, value: issues.length === 0 ? (value as T) : undefined, issues };
}

export function artifactValidationErrorSummary(kind: ArtifactKind, issues: ArtifactValidationIssue[]): string {
	const prefix = kind === "worker-handoff"
		? "Worker handoff.json schema error"
		: kind === "scrutiny-validation-report"
			? "Scrutiny validation-report.json schema error"
			: kind === "user-testing-report"
				? "User-testing report schema error"
				: "Runtime orchestrator recovery packet schema error";
	return `${prefix}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
}
