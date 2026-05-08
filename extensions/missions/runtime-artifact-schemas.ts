type ArtifactKind = "worker-handoff" | "scrutiny-validation-report" | "user-testing-report" | "reviewer-report";

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

function expectStatus(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, allowed: string[], required = true): void {
	const value = obj[key];
	if (value === undefined) {
		if (required) addIssue(issues, `/${key}`, "is required");
		return;
	}
	if (typeof value !== "string" || !allowed.includes(value)) addIssue(issues, `/${key}`, `must be one of: ${allowed.join(", ")}`);
}

function expectStringArray(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false): void {
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
		if (typeof value[i] !== "string") addIssue(issues, `/${key}/${i}`, "must be a string");
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

function expectObjectArray(issues: ArtifactValidationIssue[], obj: Record<string, unknown>, key: string, required = false): void {
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
		if (!isRecord(value[i])) addIssue(issues, `/${key}/${i}`, "must be an object");
	}
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
	expectObjectArray(issues, value, "assertions", true);
	expectObjectArray(issues, value, "defects", true);
	expectObjectArray(issues, value, "procedureFindings", true);
	expectStatus(issues, value, "recommendation", ["accept", "fix", "replan", "ask-user"]);
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

function validateReviewerReport(value: unknown): ArtifactValidationIssue[] {
	const issues: ArtifactValidationIssue[] = [];
	if (!isRecord(value)) {
		addIssue(issues, "/", "must be a JSON object");
		return issues;
	}
	expectString(issues, value, "reviewerId", true);
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
				: validateReviewerReport(value);
	return { ok: issues.length === 0, value: issues.length === 0 ? (value as T) : undefined, issues };
}

export function artifactValidationErrorSummary(kind: ArtifactKind, issues: ArtifactValidationIssue[]): string {
	const prefix = kind === "worker-handoff"
		? "Worker handoff.json schema error"
		: kind === "scrutiny-validation-report"
			? "Scrutiny validation-report.json schema error"
			: kind === "user-testing-report"
				? "User-testing report schema error"
				: "Reviewer report schema error";
	return `${prefix}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
}
