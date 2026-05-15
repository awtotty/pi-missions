export type Status = "planning" | "planned" | "running" | "paused" | "blocked" | "complete" | "failed";
export type ItemStatus = "pending" | "running" | "complete" | "failed" | "skipped";
export type MissionRole = "orchestrator" | "worker" | "validator";
export type MissionRoleModels = Record<MissionRole, string>;

export const DEFAULT_MILESTONE_VALIDATION_FAILURE_LIMIT = 5;

export interface MissionFeature {
	id: string;
	title: string;
	description: string;
	dependencies?: string[];
	status: ItemStatus;
	runId?: string;
	commit?: string;
	/** @deprecated Feature-level validation state is legacy; use milestone.validationState/run ids. */
	validationRunId?: string;
	/** @deprecated Feature-level user-testing state is legacy; use milestone.validationState.userTestingRunId. */
	userTestingRunId?: string;
	/** @deprecated Standalone reviewer state is legacy and will be removed from the run loop. */
	reviewerRunIds?: string[];
	/** @deprecated Milestone validation owns user-testing requirements. */
	userTesting?: { required?: boolean; instructions?: string };
	/** @deprecated Standalone reviewer config is legacy. */
	reviewers?: Array<{ id: string; focusAreas?: string; instructions?: string }>;
	/** @deprecated Feature-level user-testing pending state is legacy. */
	userTestingPending?: boolean;
	/** @deprecated Standalone reviewer pending state is legacy. */
	reviewerPending?: boolean;
}

export interface MissionMilestoneValidationState {
	runId?: string;
	userTestingRunId?: string;
	failureCount?: number;
	failureLimit?: number;
	userTesting?: {
		required?: boolean;
		instructions?: string;
	};
}

export interface MissionMilestone {
	id: string;
	title: string;
	objective?: string;
	validation?: string;
	status: ItemStatus;
	features: MissionFeature[];
	validationRunId?: string;
	validationState?: MissionMilestoneValidationState;
}

export interface MissionValidationConfig {
	failureLimit?: number;
}

export type MissionRunKind = "worker" | "validator" | "user-testing-validator";
export interface MissionActiveRunOwnership {
	schemaVersion: 1;
	kind: MissionRunKind;
	itemId: string;
	runId: string;
	parentPid: number;
	parentSessionMarker: string;
	startedAt: string;
	intent: "active";
}

export interface MissionRunnerLockArtifact {
	schemaVersion: 1;
	missionId: string;
	ownerPid: number;
	ownerSessionMarker: string;
	acquiredAt: string;
	heartbeatAt: string;
	heartbeatTimeoutMs: number;
	status: "active" | "released";
	releasedAt?: string;
	releasedReason?: string;
	recoveredFrom?: {
		ownerPid: number;
		ownerSessionMarker: string;
		heartbeatAt: string;
		status: "active" | "released";
	};
}

export interface MissionState {
	schemaVersion: 1;
	id: string;
	title: string;
	status: Status;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	models: MissionRoleModels;
	currentMilestoneId?: string;
	currentFeatureId?: string;
	executionStartedAt?: string;
	pauseRequestedAt?: string;
	latestBlock?: MissionBlockMetadata;
	activeRun?: MissionActiveRunOwnership;
	validation?: MissionValidationConfig;
	features?: MissionFeature[];
	milestones?: MissionMilestone[];
}

export interface ClearedMissionsState {
	schemaVersion: 1;
	updatedAt: string;
	clearedMissionIds: string[];
}

export interface MissionGlobalSettings {
	schemaVersion: 1;
	updatedAt: string;
	models: MissionRoleModels;
}

export interface ClearCompletedResult {
	clearedIds: string[];
	alreadyClearedIds: string[];
	completedIds: string[];
	text: string;
}

export interface MissionOrchestratorSessionState {
	schemaVersion: 1;
	cwd: string;
	updatedAt: string;
	activeMissionId?: string;
	activePlanningMissionId?: string;
	activeRunningMissionId?: string;
	lastMissionId?: string;
	context?: {
		id: string;
		title: string;
		status: Status;
		currentMilestoneId?: string;
		currentFeatureId?: string;
	};
}

export interface MissionOrchestratorSessionRecord {
	schemaVersion: 1;
	missionId: string;
	sessionId: string;
	sessionPath: string;
	createdAt: string;
	active: boolean;
}

export interface MissionChildSessionRecord {
	schemaVersion: 1;
	missionId: string;
	runId: string;
	role: "worker" | "validator" | "user-testing-validator";
	featureId?: string;
	milestoneId: string;
	attempt: number;
	status: string;
	runDir: string;
	transcriptPath: string;
	stderrPath: string;
	sessionId?: string;
	sessionPath?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface MissionChildSessionRegistry {
	schemaVersion: 1;
	updatedAt: string;
	records: MissionChildSessionRecord[];
}

export interface MissionCommandResult {
	ok: boolean;
	text: string;
	details?: unknown;
}

export type RunnerCommandName = "start" | "pause-after-current" | "resume" | "retry-feature" | "block" | "unblock" | "status" | "cancel-current-child";

export interface RunnerCommandInput {
	command: RunnerCommandName;
	missionId?: string;
	featureId?: string;
	reason?: string;
	source: string;
}

export interface RunResult {
	exitCode: number;
	messages: import("@earendil-works/pi-ai").Message[];
	stderr: string;
	finalText: string;
}

export type BlockReasonCategory = "child_exit_nonzero" | "missing_handoff" | "dirty_worktree" | "worker_reported_blocked" | "validator_report_failed" | "missing_validation_report" | "no_runnable_pending_work";

export interface MissionBlockSummary {
	kind: "worker" | "validator" | "user-testing-validator";
	missionId: string;
	missionTitle: string;
	milestoneId: string;
	milestoneTitle: string;
	featureId?: string;
	featureTitle?: string;
	runId: string;
	runDir: string;
	exitCode: number;
	status?: string;
	dirty?: string;
	artifactPaths: string[];
	reasonCategory?: BlockReasonCategory;
}

export interface MissionBlockMetadata {
	schemaVersion: 1;
	timestamp: string;
	reasonCategory: BlockReasonCategory;
	kind: "worker" | "validator" | "user-testing-validator";
	failedItemId: string;
	failedItemTitle: string;
	missionId: string;
	milestoneId: string;
	featureId?: string;
	runId: string;
	runDir: string;
	exitCode: number;
	status?: string;
	dirty?: string;
	artifactPaths: string[];
}

export interface MissionRunContext {
	label: string;
	runId: string;
	runDir: string;
	kind: "worker" | "validator" | "user-testing-validator";
	itemId: string;
	itemTitle: string;
	status?: string;
}

export type MissionRunLifecycleState = "active" | "completed" | "blocked" | "interrupted";

export interface MissionRunLifecycleClassification {
	state: MissionRunLifecycleState;
	run?: MissionRunContext;
	reason: string;
}

export interface ValidationContractAssertion {
	id?: string;
	category?: string;
	severity?: string;
	assertion?: string;
	verification?: string;
}

export const ORCHESTRATOR_STATE_ENTRY = "missions-orchestrator-state";
export const PLANNING_KICKOFF_ENTRY = "missions-planning-kickoff";
export const LEGACY_ACTIVE_PLANNING_ENTRY = "missions-active-planning";

export const MISSION_ROLES: MissionRole[] = ["orchestrator", "worker", "validator"];
export const DEFAULT_ROLE_MODELS: MissionRoleModels = { orchestrator: "default", worker: "default", validator: "default" };
