import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "../..");
const BASE_SKILLS = {
	orchestrator: path.join(PACKAGE_ROOT, "skills/mission-orchestrator/SKILL.md"),
	worker: path.join(PACKAGE_ROOT, "skills/mission-worker/SKILL.md"),
	validator: path.join(PACKAGE_ROOT, "skills/mission-validator/SKILL.md"),
};

type Status = "planning" | "planned" | "running" | "paused" | "blocked" | "complete" | "failed";
type ItemStatus = "pending" | "running" | "complete" | "failed" | "skipped";
type MissionRole = "orchestrator" | "worker" | "validator";
type MissionRoleModels = Record<MissionRole, string>;

interface MissionFeature {
	id: string;
	title: string;
	description: string;
	dependencies?: string[];
	status: ItemStatus;
	runId?: string;
	commit?: string;
}

interface MissionMilestone {
	id: string;
	title: string;
	objective?: string;
	validation?: string;
	status: ItemStatus;
	features: MissionFeature[];
	validationRunId?: string;
}

interface MissionState {
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
	/**
	 * Durable marker that implementation has passed the explicit start/run gate.
	 * Planned missions without this marker (or legacy execution events) must not
	 * be treated as previously started by recovery automation.
	 */
	executionStartedAt?: string;
	latestBlock?: MissionBlockMetadata;
	milestones: MissionMilestone[];
}

interface ClearedMissionsState {
	schemaVersion: 1;
	updatedAt: string;
	clearedMissionIds: string[];
}

interface MissionGlobalSettings {
	schemaVersion: 1;
	updatedAt: string;
	models: MissionRoleModels;
}

interface ClearCompletedResult {
	clearedIds: string[];
	alreadyClearedIds: string[];
	completedIds: string[];
	text: string;
}

interface MissionOrchestratorSessionState {
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

const ORCHESTRATOR_STATE_ENTRY = "missions-orchestrator-state";
const PLANNING_KICKOFF_ENTRY = "missions-planning-kickoff";
const LEGACY_ACTIVE_PLANNING_ENTRY = "missions-active-planning";

interface MissionCommandResult {
	ok: boolean;
	text: string;
	details?: unknown;
}

interface RunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	finalText: string;
}

type BlockReasonCategory = "child_exit_nonzero" | "missing_handoff" | "dirty_worktree" | "worker_reported_blocked" | "validator_report_failed" | "missing_validation_report";

interface MissionBlockSummary {
	kind: "worker" | "validator";
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

interface MissionBlockMetadata {
	schemaVersion: 1;
	timestamp: string;
	reasonCategory: BlockReasonCategory;
	kind: "worker" | "validator";
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

interface MissionRunContext {
	label: string;
	runId: string;
	runDir: string;
	kind: "worker" | "validator";
	itemId: string;
	itemTitle: string;
	status?: string;
}

const MISSION_ROLES: MissionRole[] = ["orchestrator", "worker", "validator"];
const DEFAULT_ROLE_MODELS: MissionRoleModels = { orchestrator: "default", worker: "default", validator: "default" };

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeRoleModels(models?: Partial<Record<MissionRole, unknown>>): MissionRoleModels {
	const normalized = { ...DEFAULT_ROLE_MODELS };
	for (const role of MISSION_ROLES) {
		const value = models?.[role];
		if (typeof value === "string" && value.trim()) normalized[role] = value.trim();
	}
	return normalized;
}

function isMissionRole(value: string): value is MissionRole {
	return (MISSION_ROLES as string[]).includes(value);
}

function missionRoot(cwd: string): string {
	return path.join(cwd, ".pi", "missions");
}

function missionDir(cwd: string, id: string): string {
	return path.join(missionRoot(cwd), id);
}

function clearedMissionsFile(cwd: string): string {
	return path.join(missionRoot(cwd), "cleared.json");
}

function globalSettingsFile(cwd: string): string {
	return path.join(missionRoot(cwd), "settings.json");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendEvent(dir: string, type: string, data: unknown): void {
	fs.appendFileSync(path.join(dir, "event-log.jsonl"), `${JSON.stringify({ ts: nowIso(), type, data })}\n`);
}

const EXECUTION_STARTED_EVENT_TYPES = new Set(["mission_execution_started", "worker_started", "validator_started", "mission_block_recorded", "mission_complete"]);

function hasMissionExecutionStarted(cwd: string, mission: MissionState): boolean {
	if (typeof mission.executionStartedAt === "string" && mission.executionStartedAt.trim()) return true;
	const logFile = path.join(missionDir(cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return false;
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: unknown };
			if (typeof event.type === "string" && EXECUTION_STARTED_EVENT_TYPES.has(event.type)) return true;
		} catch {
			// Ignore malformed historical log entries; execution-start detection is best-effort for legacy missions.
		}
	}
	return false;
}

function markMissionExecutionStarted(mission: MissionState): MissionState {
	if (mission.executionStartedAt) return mission;
	return { ...mission, executionStartedAt: nowIso() };
}

function hasRunnablePersistedPlan(cwd: string, mission: MissionState): boolean {
	try {
		const hasFeature = Array.isArray(mission.milestones) && mission.milestones.some((milestone) => Array.isArray(milestone.features) && milestone.features.length > 0);
		return hasFeature && fs.existsSync(path.join(missionDir(cwd, mission.id), "plan/validation-contract.json"));
	} catch {
		return false;
	}
}

function normalizeMissionForRuntime(cwd: string, mission: MissionState): MissionState {
	if (mission.status === "planning" && hasRunnablePersistedPlan(cwd, mission)) return { ...mission, status: "planned" };
	return mission;
}

function loadMission(cwd: string, id: string): MissionState {
	return normalizeMissionForRuntime(cwd, readJson<MissionState>(path.join(missionDir(cwd, id), "mission.json")));
}

function saveMission(cwd: string, mission: MissionState): void {
	mission.updatedAt = nowIso();
	writeJson(path.join(missionDir(cwd, mission.id), "mission.json"), mission);
}

function listMissions(cwd: string): MissionState[] {
	const root = missionRoot(cwd);
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.map((name) => path.join(root, name, "mission.json"))
		.filter((file) => fs.existsSync(file))
		.map((file) => normalizeMissionForRuntime(cwd, readJson<MissionState>(file)))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function latestMission(cwd: string): MissionState | undefined {
	return listMissions(cwd)[0];
}

function latestVisibleMission(cwd: string): MissionState | undefined {
	return listMissions(cwd).find((mission) => !isMissionCleared(cwd, mission.id));
}

function isActiveMissionStatus(status: Status): boolean {
	return status === "planning" || status === "planned" || status === "running" || status === "paused" || status === "blocked";
}

function activeMissionFromState(cwd: string, state?: MissionOrchestratorSessionState): MissionState | undefined {
	const ids = [state?.activeMissionId, state?.activePlanningMissionId, state?.activeRunningMissionId, state?.lastMissionId].filter((id): id is string => Boolean(id));
	for (const id of ids) {
		try {
			const mission = loadMission(cwd, id);
			if (isActiveMissionStatus(mission.status)) return mission;
		} catch {
			// Ignore stale session entries that point at missions no longer present in this checkout.
		}
	}
	return listMissions(cwd).find((mission) => isActiveMissionStatus(mission.status));
}

function buildOrchestratorState(cwd: string, mission?: MissionState, overrides: Partial<MissionOrchestratorSessionState> = {}): MissionOrchestratorSessionState {
	const hasOverride = (key: keyof MissionOrchestratorSessionState) => Object.prototype.hasOwnProperty.call(overrides, key);
	const activeMissionId = hasOverride("activeMissionId") ? overrides.activeMissionId : mission?.id;
	const activePlanningMissionId = hasOverride("activePlanningMissionId") ? overrides.activePlanningMissionId : mission?.status === "planning" ? mission.id : undefined;
	const activeRunningMissionId = hasOverride("activeRunningMissionId") ? overrides.activeRunningMissionId : mission?.status === "running" || mission?.status === "paused" ? mission.id : undefined;
	return {
		schemaVersion: 1,
		cwd,
		updatedAt: nowIso(),
		activeMissionId,
		activePlanningMissionId,
		activeRunningMissionId,
		lastMissionId: overrides.lastMissionId ?? mission?.id ?? activeMissionId,
		context: mission
			? {
				id: mission.id,
				title: mission.title,
				status: mission.status,
				currentMilestoneId: mission.currentMilestoneId,
				currentFeatureId: mission.currentFeatureId,
			}
			: overrides.context,
	};
}

function latestOrchestratorStateFromSession(cwd: string, entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): MissionOrchestratorSessionState | undefined {
	let state: MissionOrchestratorSessionState | undefined;
	let legacyPlanningId: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === ORCHESTRATOR_STATE_ENTRY) {
			const data = entry.data as Partial<MissionOrchestratorSessionState> | undefined;
			if (data?.schemaVersion === 1 && (!data.cwd || data.cwd === cwd)) state = { ...data, schemaVersion: 1, cwd, updatedAt: data.updatedAt || nowIso() } as MissionOrchestratorSessionState;
		}
		if (entry.customType === LEGACY_ACTIVE_PLANNING_ENTRY) {
			legacyPlanningId = (entry.data as { id?: string } | undefined)?.id;
		}
	}
	if (!state && legacyPlanningId) return buildOrchestratorState(cwd, undefined, { activeMissionId: legacyPlanningId, activePlanningMissionId: legacyPlanningId, lastMissionId: legacyPlanningId });
	return state;
}

function lightweightMissionContext(cwd: string, state?: MissionOrchestratorSessionState): string | undefined {
	const mission = activeMissionFromState(cwd, state);
	if (!mission) return undefined;
	const dir = missionDir(cwd, mission.id);
	const mode = mission.status === "planning" ? "planning" : mission.status === "running" || mission.status === "paused" ? "execution" : "available";
	return [
		"[MISSION ORCHESTRATOR CONTEXT]",
		`Active mission (${mode}): ${mission.id} — ${mission.title} [${mission.status}]`,
		`Mission directory: ${dir}`,
		mission.currentMilestoneId ? `Current milestone: ${mission.currentMilestoneId}` : undefined,
		mission.currentFeatureId ? `Current feature: ${mission.currentFeatureId}` : undefined,
		mission.status === "planning" ? "The current assistant/session is the mission orchestrator. Continue planning inline when the user discusses this mission." : undefined,
		"Use mission tools when the user asks about this mission; /missions run and mission_start_execution are the confirmation gate before implementation starts.",
		"This is lightweight context only: answer unrelated user requests normally and do not force the conversation into mission planning unless relevant.",
	].filter((line): line is string => Boolean(line)).join("\n");
}

function missionPlanningKickoffContext(cwd: string, goal: string): string {
	return [
		"[MISSION ORCHESTRATOR REQUEST]",
		"The user invoked /missions in the current session.",
		"You are the mission orchestrator in this same ongoing conversation; do not assume a detached planning mode or wizard UI.",
		`Target repository cwd: ${cwd}`,
		`Current time: ${nowIso()}`,
		"",
		"User goal or context:",
		goal || "The user wants to discuss or continue mission planning.",
		"",
		"Use the mission-orchestrator skill for mission planning. Do not write application code while planning.",
		"First brainstorm with the user: ask clarifying questions, push back on scope, surface tradeoffs, and iterate in normal chat.",
		"Do not call mission_write_plan merely because /missions was invoked. Call mission_write_plan only when you judge the plan and validation contract are mature enough to persist, or when the user explicitly asks you to save the draft.",
		"After the user has reviewed the persisted plan, use mission_start_execution as the single explicit start/run confirmation gate before implementation begins.",
		"The user may ask unrelated questions at any time; answer those normally and return to mission planning only when relevant.",
	].join("\n");
}

function readClearedMissions(cwd: string): ClearedMissionsState {
	const file = clearedMissionsFile(cwd);
	if (!fs.existsSync(file)) return { schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [] };
	const parsed = readJson<Partial<ClearedMissionsState>>(file);
	return {
		schemaVersion: 1,
		updatedAt: parsed.updatedAt || nowIso(),
		clearedMissionIds: Array.isArray(parsed.clearedMissionIds) ? [...new Set(parsed.clearedMissionIds.filter((id): id is string => typeof id === "string"))] : [],
	};
}

function writeClearedMissions(cwd: string, state: ClearedMissionsState): void {
	writeJson(clearedMissionsFile(cwd), { ...state, schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [...new Set(state.clearedMissionIds)].sort() });
}

function readMissionGlobalSettings(cwd: string): MissionGlobalSettings {
	const file = globalSettingsFile(cwd);
	if (!fs.existsSync(file)) return { schemaVersion: 1, updatedAt: nowIso(), models: { ...DEFAULT_ROLE_MODELS } };
	const parsed = readJson<Partial<MissionGlobalSettings>>(file);
	return {
		schemaVersion: 1,
		updatedAt: parsed.updatedAt || nowIso(),
		models: normalizeRoleModels(parsed.models),
	};
}

function writeMissionGlobalSettings(cwd: string, settings: MissionGlobalSettings): void {
	writeJson(globalSettingsFile(cwd), { schemaVersion: 1, updatedAt: nowIso(), models: normalizeRoleModels(settings.models) });
}

function resolveRoleModel(cwd: string, mission: MissionState, role: MissionRole): string {
	const missionModel = mission.models?.[role];
	if (missionModel && missionModel !== "default") return missionModel;
	return readMissionGlobalSettings(cwd).models[role];
}

function formatGlobalModels(cwd: string): string {
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

function setGlobalModel(cwd: string, role: MissionRole, model: string): string {
	const settings = readMissionGlobalSettings(cwd);
	settings.models[role] = model.trim() || "default";
	writeMissionGlobalSettings(cwd, settings);
	return formatGlobalModels(cwd);
}

function findMissionModelReference(modelReference: string, models: Model<Api>[]): Model<Api> | undefined {
	const reference = modelReference.trim();
	if (!reference) return undefined;

	const slash = reference.indexOf("/");
	if (slash > 0) {
		const provider = reference.slice(0, slash);
		const modelId = reference.slice(slash + 1);
		const canonical = models.find((model) => model.provider === provider && model.id === modelId);
		if (canonical) return canonical;
	}

	const exactIdMatches = models.filter((model) => model.id === reference);
	if (exactIdMatches.length === 1) return exactIdMatches[0];

	const exactNameMatches = models.filter((model) => model.name === reference);
	if (exactNameMatches.length === 1) return exactNameMatches[0];

	return undefined;
}

function describeModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

async function applyGlobalOrchestratorModelDefault(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<string | undefined> {
	const modelReference = readMissionGlobalSettings(ctx.cwd).models.orchestrator;
	if (!modelReference || modelReference === "default") return undefined;

	ctx.modelRegistry.refresh();
	const model = findMissionModelReference(modelReference, ctx.modelRegistry.getAll());
	if (!model) {
		const warning = `Mission orchestrator model default '${modelReference}' was not applied: no matching model was found. Use a provider/model reference from /model or set /missions models orchestrator default.`;
		ctx.ui.notify(warning, "warning");
		return warning;
	}

	if (ctx.model?.provider === model.provider && ctx.model.id === model.id) {
		return `Mission orchestrator model default already active: ${describeModel(model)}.`;
	}

	const switched = await pi.setModel(model);
	if (!switched) {
		const warning = `Mission orchestrator model default '${modelReference}' resolved to ${describeModel(model)} but was not applied because credentials are unavailable for provider '${model.provider}'. Configure credentials or set /missions models orchestrator default.`;
		ctx.ui.notify(warning, "warning");
		return warning;
	}

	const message = `Mission orchestrator model default applied: ${describeModel(model)}.`;
	ctx.ui.notify(message, "info");
	return message;
}

function isMissionCleared(cwd: string, id: string): boolean {
	return readClearedMissions(cwd).clearedMissionIds.includes(id);
}

function clearCompletedMissions(cwd: string): ClearCompletedResult {
	const missions = listMissions(cwd);
	const completedIds = missions.filter((mission) => mission.status === "complete").map((mission) => mission.id);
	const state = readClearedMissions(cwd);
	const existing = new Set(state.clearedMissionIds);
	const clearedIds = completedIds.filter((id) => !existing.has(id));
	const alreadyClearedIds = completedIds.filter((id) => existing.has(id));
	if (clearedIds.length > 0) {
		writeClearedMissions(cwd, { ...state, clearedMissionIds: [...state.clearedMissionIds, ...clearedIds] });
		for (const id of clearedIds) appendEvent(missionDir(cwd, id), "mission_cleared", { clearedStateFile: clearedMissionsFile(cwd) });
	}
	const text = clearedIds.length > 0
		? `Cleared ${clearedIds.length} completed mission${clearedIds.length === 1 ? "" : "s"}: ${clearedIds.join(", ")}. Artifacts were not deleted and statuses remain complete.`
		: completedIds.length > 0
			? `No completed missions to clear; ${alreadyClearedIds.length} completed mission${alreadyClearedIds.length === 1 ? " is" : "s are"} already cleared.`
			: "No completed missions to clear.";
	return { clearedIds, alreadyClearedIds, completedIds, text };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
	return { command: process.execPath, args };
}

function textFromMessage(msg: Message): string {
	if (msg.role !== "assistant") return "";
	return msg.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function runPiChild(options: {
	cwd: string;
	prompt: string;
	model?: string;
	systemPromptFiles: string[];
	transcriptFile: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<RunResult> {
	ensureDir(path.dirname(options.transcriptFile));
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.model && options.model !== "default") args.push("--model", options.model);
	for (const file of options.systemPromptFiles) {
		if (fs.existsSync(file)) args.push("--append-system-prompt", file);
	}
	args.push(options.prompt);

	const result: RunResult = { exitCode: 0, messages: [], stderr: "", finalText: "" };
	await new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let buffer = "";
		const transcript = fs.createWriteStream(options.transcriptFile, { flags: "a" });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			transcript.write(`${line}\n`);
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				result.messages.push(msg);
				const text = textFromMessage(msg);
				if (text) {
					result.finalText = text;
					options.onUpdate?.(text);
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 0;
			transcript.end();
			resolve();
		});
		proc.on("error", (error) => {
			result.exitCode = 1;
			result.stderr += String(error);
			transcript.end();
			resolve();
		});
		if (options.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
			};
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
	});
	return result;
}

async function gitPorcelain(cwd: string): Promise<string> {
	const result = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
		const proc = spawn("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("close", () => resolve({ stdout, stderr }));
		proc.on("error", (e) => resolve({ stdout, stderr: String(e) }));
	});
	return result.stdout.trim();
}

async function gitHead(cwd: string): Promise<string | undefined> {
	return await new Promise((resolve) => {
		const proc = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : undefined));
		proc.on("error", () => resolve(undefined));
	});
}

function latestBlockFromArtifacts(mission: MissionState): MissionBlockMetadata | undefined {
	if (mission.latestBlock) return mission.latestBlock;
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return undefined;
	let latest: MissionBlockMetadata | undefined;
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; data?: MissionBlockMetadata };
			if (event.type === "mission_block_recorded" && event.data?.schemaVersion === 1) latest = event.data;
		} catch {
			// Ignore malformed historical log entries; status rendering should be best-effort.
		}
	}
	return latest;
}

function compareRunIds(a: string, b: string): number {
	const aPrefix = Number.parseInt(a, 10);
	const bPrefix = Number.parseInt(b, 10);
	if (Number.isFinite(aPrefix) && Number.isFinite(bPrefix) && aPrefix !== bPrefix) return aPrefix - bPrefix;
	return a.localeCompare(b);
}

function unfinishedValidatorRunContextsFromEvents(mission: MissionState, recordedRunIds: Set<string>): MissionRunContext[] {
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return [];
	const starts = new Map<string, { milestoneId: string }>();
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; data?: { milestoneId?: unknown; runId?: unknown } };
			const runId = typeof event.data?.runId === "string" ? event.data.runId : undefined;
			const milestoneId = typeof event.data?.milestoneId === "string" ? event.data.milestoneId : undefined;
			if (!runId || !milestoneId) continue;
			if (event.type === "validator_started") starts.set(runId, { milestoneId });
			if (event.type === "validator_finished") starts.delete(runId);
		} catch {
			// Ignore malformed historical log entries; status rendering should be best-effort.
		}
	}
	return [...starts.entries()]
		.filter(([runId]) => !recordedRunIds.has(runId))
		.map(([runId, started]) => {
			const milestone = mission.milestones.find((m) => m.id === started.milestoneId);
			return {
				label: "Current validator run",
				runId,
				runDir: path.join(missionDir(mission.cwd, mission.id), "runs", runId),
				kind: "validator" as const,
				itemId: started.milestoneId,
				itemTitle: milestone?.title ?? started.milestoneId,
				status: "running",
			};
		});
}

function missionRunContexts(mission: MissionState): MissionRunContext[] {
	const contexts: MissionRunContext[] = [];
	const recordedRunIds = new Set<string>();
	for (const milestone of mission.milestones) {
		for (const feature of milestone.features) {
			if (!feature.runId) continue;
			recordedRunIds.add(feature.runId);
			contexts.push({
				label: `${feature.status === "running" ? "Current" : "Last"} worker run`,
				runId: feature.runId,
				runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId),
				kind: "worker",
				itemId: feature.id,
				itemTitle: feature.title,
				status: feature.status,
			});
		}
		if (milestone.validationRunId) {
			recordedRunIds.add(milestone.validationRunId);
			contexts.push({
				label: `${milestone.status === "running" ? "Current" : "Last"} validator run`,
				runId: milestone.validationRunId,
				runDir: path.join(missionDir(mission.cwd, mission.id), "runs", milestone.validationRunId),
				kind: "validator",
				itemId: milestone.id,
				itemTitle: milestone.title,
				status: milestone.status,
			});
		}
	}
	contexts.push(...unfinishedValidatorRunContextsFromEvents(mission, recordedRunIds));
	return contexts.sort((a, b) => compareRunIds(a.runId, b.runId));
}

function currentOrLastRunContext(mission: MissionState): MissionRunContext | undefined {
	const contexts = missionRunContexts(mission);
	return contexts.filter((ctx) => ctx.status === "running").at(-1) ?? contexts.at(-1);
}

function describeBlock(block: MissionBlockMetadata): string {
	return `${block.reasonCategory} on ${block.kind} ${block.failedItemId} (${block.failedItemTitle}); run ${block.runId}${block.status ? ` reported ${block.status}` : ""}`;
}

function nextSuggestedAction(mission: MissionState, run?: MissionRunContext, block?: MissionBlockMetadata): string {
	if (mission.status === "planning") return "Continue planning, then persist the plan when it is ready.";
	if (mission.status === "planned") return `Run /missions run ${mission.id} to start execution.`;
	if (mission.status === "running") return run ? `Monitor ${run.runDir} or wait for run ${run.runId} to finish.` : "Mission is running; wait for the next worker or validator update.";
	if (mission.status === "paused") return `Run /missions resume ${mission.id} when ready.`;
	if (mission.status === "blocked") return block ? `Inspect block artifacts in ${block.runDir}, decide the recovery path, then revise or resume the mission.` : `Inspect ${missionDir(mission.cwd, mission.id)} and decide whether to revise or resume the mission.`;
	if (mission.status === "failed") return block ? `Inspect failure artifacts in ${block.runDir} before retrying or revising.` : `Inspect ${missionDir(mission.cwd, mission.id)} before retrying or revising.`;
	return `Mission is complete. Use /missions clear to hide completed missions from default Mission Control UI.`;
}

function updateWidget(ctx: ExtensionContext, mission?: MissionState): void {
	// Mission Control is now the rich mission visibility surface. Keep only the
	// compact footer/status indicator here and always clear the legacy mission
	// widget so stale rich mission UI cannot survive reload, clear, block, or
	// completion transitions.
	ctx.ui.setWidget("missions", undefined);
	if (!mission || (mission.status === "complete" && isMissionCleared(mission.cwd, mission.id))) {
		ctx.ui.setStatus("missions", undefined);
		return;
	}
	const features = mission.milestones.flatMap((m) => m.features);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	const run = currentOrLastRunContext(mission);
	ctx.ui.setStatus("missions", `🚀 ${done}/${features.length} ${mission.status}${run ? ` ${run.runId}` : ""}`);
}

function mark(status: string): string {
	if (status === "complete") return "✓";
	if (status === "running") return "⏳";
	if (status === "failed" || status === "blocked") return "✗";
	if (status === "skipped") return "↷";
	return "○";
}

function existingPaths(paths: string[]): string[] {
	return paths.filter((file) => fs.existsSync(file));
}

function classifyWorkerBlock(result: RunResult, handoff: any, dirty: string): BlockReasonCategory {
	if (result.exitCode !== 0) return "child_exit_nonzero";
	if (!handoff) return "missing_handoff";
	if (dirty) return "dirty_worktree";
	return "worker_reported_blocked";
}

function classifyValidatorBlock(result: RunResult, report: any): BlockReasonCategory {
	if (result.exitCode !== 0) return "child_exit_nonzero";
	if (!report) return "missing_validation_report";
	return "validator_report_failed";
}

function blockMetadataFromSummary(block: MissionBlockSummary, reasonCategory: BlockReasonCategory): MissionBlockMetadata {
	return {
		schemaVersion: 1,
		timestamp: nowIso(),
		reasonCategory,
		kind: block.kind,
		failedItemId: block.kind === "worker" ? block.featureId ?? block.milestoneId : block.milestoneId,
		failedItemTitle: block.kind === "worker" ? block.featureTitle ?? block.milestoneTitle : block.milestoneTitle,
		missionId: block.missionId,
		milestoneId: block.milestoneId,
		featureId: block.featureId,
		runId: block.runId,
		runDir: block.runDir,
		exitCode: block.exitCode,
		status: block.status,
		dirty: block.dirty,
		artifactPaths: block.artifactPaths,
	};
}

function persistMissionBlock(dir: string, mission: MissionState, block: MissionBlockSummary, reasonCategory: BlockReasonCategory): void {
	block.reasonCategory = reasonCategory;
	const latestBlock = blockMetadataFromSummary(block, reasonCategory);
	mission.latestBlock = latestBlock;
	appendEvent(dir, "mission_block_recorded", latestBlock);
}

function formatMissionBlockMessage(block: MissionBlockSummary): string {
	const failedItem = block.kind === "worker"
		? `Feature ${block.featureId} - ${block.featureTitle}`
		: `Milestone ${block.milestoneId} - ${block.milestoneTitle}`;
	return [
		"[MISSION BLOCKED - RECOVERY CONTEXT]",
		"A mission child agent blocked execution. Continue recovery in this main chat as the mission orchestrator; do not treat the mission as dead.",
		"",
		`Mission: ${block.missionId} — ${block.missionTitle}`,
		`Blocked during: ${block.kind}`,
		`Failed item: ${failedItem}`,
		block.kind === "worker" ? `Milestone: ${block.milestoneId} - ${block.milestoneTitle}` : undefined,
		`Run id: ${block.runId}`,
		`Run directory: ${block.runDir}`,
		block.reasonCategory ? `Reason category: ${block.reasonCategory}` : undefined,
		`Exit code: ${block.exitCode}`,
		block.status ? `Reported status: ${block.status}` : undefined,
		block.dirty ? `Git status after child run:\n${block.dirty}` : undefined,
		"",
		"Artifacts:",
		...(block.artifactPaths.length > 0 ? block.artifactPaths.map((file) => `- ${file}`) : ["- No handoff/report artifact found; inspect transcript/stderr in the run directory."]),
		"",
		"Suggested next inspection steps:",
		block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : "1. Read validation-report.json and validation-report.md if present.",
		"2. Inspect transcript.jsonl and stderr.txt in the run directory for the child-agent failure mode.",
		"3. Check `git status --short` and review any relevant diffs/commits mentioned by the artifacts.",
		"4. Decide whether this is an implementation defect, validation defect, planning issue, environmental/tooling issue, or procedural failure; revise/resume the mission only after the recovery path is clear.",
	].filter((line): line is string => Boolean(line)).join("\n");
}

function emitMissionBlockMessage(pi: ExtensionAPI, block: MissionBlockSummary): void {
	pi.sendMessage({
		customType: "missions-block-context",
		display: true,
		content: formatMissionBlockMessage(block),
		details: block,
	}, { triggerTurn: true, deliverAs: "followUp" });
}

function summarizeMission(mission: MissionState): string {
	const features = mission.milestones.flatMap((m) => m.features);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	const run = currentOrLastRunContext(mission);
	const block = latestBlockFromArtifacts(mission);
	return [
		`Mission: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Progress: ${done}/${features.length} features`,
		`Dir: ${missionDir(mission.cwd, mission.id)}`,
		run ? `${run.label}: ${run.runId}` : "Current/last run: none recorded",
		run ? `Run item: ${run.kind} ${run.itemId} — ${run.itemTitle}` : undefined,
		run ? `Run artifacts: ${run.runDir}` : undefined,
		block ? `Blocked reason: ${describeBlock(block)}` : undefined,
		block?.artifactPaths.length ? `Block artifacts: ${block.artifactPaths.join(", ")}` : undefined,
		`Next suggested action: ${nextSuggestedAction(mission, run, block)}`,
		"",
		...mission.milestones.flatMap((m) => [
			`${mark(m.status)} ${m.id}: ${m.title}${m.validationRunId ? ` [validator ${m.validationRunId}]` : ""}`,
			...m.features.map((f) => `  ${mark(f.status)} ${f.id}: ${f.title}${f.runId ? ` [run ${f.runId}]` : ""}${f.commit ? ` (${f.commit})` : ""}`),
		]),
	].filter((line): line is string => line !== undefined).join("\n");
}

function boundedExcerpt(text: string, maxChars = 700): string {
	const normalized = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
	if (normalized.length <= maxChars) return normalized || "(no objective text provided)";
	return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function validationSummary(validationContractJson: unknown): string {
	const maybeAssertions = (validationContractJson as { assertions?: unknown } | undefined)?.assertions;
	if (!Array.isArray(maybeAssertions)) return "Validation: no assertions array found.";
	const categories = new Map<string, number>();
	for (const assertion of maybeAssertions) {
		const category = typeof (assertion as { category?: unknown })?.category === "string" ? (assertion as { category: string }).category : "uncategorized";
		categories.set(category, (categories.get(category) ?? 0) + 1);
	}
	const categoryText = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `${category}: ${count}`).join(", ");
	return `Validation: ${maybeAssertions.length} assertion${maybeAssertions.length === 1 ? "" : "s"}${categoryText ? ` (${categoryText})` : ""}.`;
}

function planOutline(mission: MissionState, maxMilestones = 8, maxFeaturesPerMilestone = 8): string[] {
	if (!Array.isArray(mission.milestones) || mission.milestones.length === 0) return ["(no milestones provided)"];
	const lines: string[] = [];
	for (const milestone of mission.milestones.slice(0, maxMilestones)) {
		lines.push(`${mark(milestone.status)} ${milestone.id}: ${milestone.title}`);
		const features = Array.isArray(milestone.features) ? milestone.features : [];
		for (const feature of features.slice(0, maxFeaturesPerMilestone)) {
			lines.push(`  ${mark(feature.status)} ${feature.id}: ${feature.title}`);
		}
		if (features.length > maxFeaturesPerMilestone) lines.push(`  … ${features.length - maxFeaturesPerMilestone} more feature${features.length - maxFeaturesPerMilestone === 1 ? "" : "s"}`);
	}
	if (mission.milestones.length > maxMilestones) lines.push(`… ${mission.milestones.length - maxMilestones} more milestone${mission.milestones.length - maxMilestones === 1 ? "" : "s"}`);
	return lines;
}

function persistedPlanSummary(mission: MissionState, dir: string, objectiveMd: string, validationContractJson: unknown, existingMission: boolean): string {
	const action = existingMission ? "revised" : "written";
	const nextAction = mission.status === "planning"
		? "\n\nNext: continue refining, then persist a runnable plan when it is ready."
		: mission.status === "planned"
			? `\n\nNext: review the saved plan, then run /missions run ${mission.id} or use mission_start_execution to confirm and start implementation.`
			: "";
	return [
		`Mission plan ${action}: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Artifact directory: ${dir}`,
		"",
		"Objective excerpt:",
		boundedExcerpt(objectiveMd),
		"",
		"Milestones and features:",
		...planOutline(mission),
		"",
		validationSummary(validationContractJson),
	].join("\n") + nextAction;
}

function missionListText(cwd: string): string {
	const missions = listMissions(cwd);
	return missions.length ? missions.map((m) => `${m.id}  ${m.status}${isMissionCleared(cwd, m.id) ? " (cleared)" : ""}  ${m.title}`).join("\n") : "No missions found.";
}

function visibleMissions(cwd: string): MissionState[] {
	return listMissions(cwd).filter((mission) => !isMissionCleared(cwd, mission.id));
}

function resolveMission(cwd: string, id?: string, state?: MissionOrchestratorSessionState): MissionState | undefined {
	return id ? loadMission(cwd, id) : activeMissionFromState(cwd, state) ?? latestMission(cwd);
}

function clipLine(line: string, width: number): string {
	// Leave a one-column guard for terminal/wcwidth disagreements around emoji and
	// ellipsis glyphs. Mission Control is embedded directly in the main TUI render;
	// a single over-wide custom line crashes the whole pi process.
	const limit = Math.max(1, width - 1);
	return truncateToWidth(line, limit);
}

function padLineToWidth(line: string, width: number): string {
	const clipped = clipLine(line, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function progressText(mission: MissionState): string {
	const features = mission.milestones.flatMap((m) => m.features);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	return `${done}/${features.length}`;
}

interface MissionControlEvent {
	ts?: string;
	type: string;
	data?: unknown;
}

type MissionControlSelection =
	| { kind: "mission"; mission: MissionState }
	| { kind: "block"; mission: MissionState; block: MissionBlockMetadata }
	| { kind: "milestone"; mission: MissionState; milestone: MissionMilestone }
	| { kind: "feature"; mission: MissionState; milestone: MissionMilestone; feature: MissionFeature };

function readMissionEvents(mission: MissionState, maxEvents = 8): MissionControlEvent[] {
	const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
	if (!fs.existsSync(logFile)) return [];
	const events: MissionControlEvent[] = [];
	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { ts?: unknown; type?: unknown; data?: unknown };
			if (typeof parsed.type === "string") events.push({ ts: typeof parsed.ts === "string" ? parsed.ts : undefined, type: parsed.type, data: parsed.data });
		} catch {
			// Ignore malformed historical log entries; Mission Control is best-effort/read-only.
		}
	}
	return events.slice(-maxEvents);
}

function eventDataSummary(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const record = data as Record<string, unknown>;
	const parts = [record.milestoneId, record.featureId, record.runId, record.status, record.exitCode]
		.filter((value): value is string | number => typeof value === "string" || typeof value === "number")
		.map(String);
	return parts.length ? ` (${parts.join(" · ")})` : "";
}

function runArtifactSummaryLines(run: MissionRunContext): string[] {
	const jsonFile = path.join(run.runDir, run.kind === "worker" ? "handoff.json" : "validation-report.json");
	const mdFile = path.join(run.runDir, run.kind === "worker" ? "handoff.md" : "validation-report.md");
	const transcriptFile = path.join(run.runDir, "transcript.jsonl");
	const stderrFile = path.join(run.runDir, "stderr.txt");
	const lines = [
		`${path.basename(jsonFile)}: ${fs.existsSync(jsonFile) ? jsonFile : "not available"}`,
		`${path.basename(mdFile)}: ${fs.existsSync(mdFile) ? mdFile : "not available"}`,
	];
	if (fs.existsSync(transcriptFile)) lines.push(`transcript: ${transcriptFile}`);
	if (fs.existsSync(stderrFile)) lines.push(`stderr: ${stderrFile}`);
	if (fs.existsSync(jsonFile)) {
		try {
			const artifact = readJson<Record<string, unknown>>(jsonFile);
			const status = typeof artifact.status === "string" ? artifact.status : undefined;
			const commit = typeof artifact.commit === "string" ? artifact.commit : undefined;
			const summary = typeof artifact.summary === "string" ? artifact.summary : undefined;
			if (status || commit) lines.push(`Artifact status: ${[status, commit ? `commit ${commit}` : undefined].filter(Boolean).join(" · ")}`);
			if (summary) lines.push(`Artifact summary: ${summary}`);
		} catch {
			lines.push(`Artifact summary: ${jsonFile} could not be parsed`);
		}
	}
	return lines;
}

function currentSelection(mission: MissionState): MissionControlSelection {
	const currentMilestone = mission.milestones.find((m) => m.id === mission.currentMilestoneId) ?? mission.milestones.find((m) => m.status === "running") ?? mission.milestones[0];
	if (!currentMilestone) return { kind: "mission", mission };
	const currentFeature = currentMilestone.features.find((f) => f.id === mission.currentFeatureId) ?? currentMilestone.features.find((f) => f.status === "running");
	if (currentFeature) return { kind: "feature", mission, milestone: currentMilestone, feature: currentFeature };
	return { kind: "milestone", mission, milestone: currentMilestone };
}

function blockSelectionId(block: MissionBlockMetadata): string {
	return `block:${block.runId}:${block.failedItemId}`;
}

function missionControlSelectableItems(mission: MissionState, block = latestBlockFromArtifacts(mission)): MissionControlSelection[] {
	const items: MissionControlSelection[] = [{ kind: "mission", mission }];
	if (block) items.push({ kind: "block", mission, block });
	for (const milestone of mission.milestones) {
		items.push({ kind: "milestone", mission, milestone });
		for (const feature of milestone.features) items.push({ kind: "feature", mission, milestone, feature });
	}
	return items;
}

function selectionId(selection: MissionControlSelection): string {
	if (selection.kind === "block") return blockSelectionId(selection.block);
	if (selection.kind === "feature") return selection.feature.id;
	if (selection.kind === "milestone") return selection.milestone.id;
	return selection.mission.id;
}

function missionControlSelectionById(mission: MissionState, selectedId?: string, block = latestBlockFromArtifacts(mission)): MissionControlSelection {
	if (selectedId) {
		const match = missionControlSelectableItems(mission, block).find((item) => selectionId(item) === selectedId);
		if (match) return match;
	}
	return currentSelection(mission);
}

function moveMissionControlSelection(mission: MissionState, selectedId: string | undefined, delta: number): string {
	const items = missionControlSelectableItems(mission);
	if (items.length === 0) return mission.id;
	const fallbackId = selectionId(currentSelection(mission));
	const currentIndex = Math.max(0, items.findIndex((item) => selectionId(item) === (selectedId ?? fallbackId)));
	const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta));
	return selectionId(items[nextIndex]);
}

function missionControlHeader(mission: MissionState, width: number): string[] {
	const run = currentOrLastRunContext(mission);
	const runText = run ? `${run.label}: ${run.runId} (${run.kind} ${run.itemId})` : "Current run: none";
	return [
		`Mission Control (read-only) — ${mission.title}`,
		`Status: ${mission.status}  Progress: ${progressText(mission)}  ${runText}`,
		`Mission: ${mission.id}`,
	].map((line) => clipLine(line, width));
}

function missionTreeLines(mission: MissionState, selection: MissionControlSelection, block?: MissionBlockMetadata): string[] {
	const selectedId = selectionId(selection);
	const lines = ["Mission tree", `${selectedId === mission.id ? ">" : " "} ${mark(mission.status)} ${mission.id}`];
	if (block) lines.push(`${selectedId === blockSelectionId(block) ? ">" : " "} ! Block ${block.reasonCategory} on ${block.failedItemId}`);
	for (const milestone of mission.milestones) {
		lines.push(`${selectedId === milestone.id ? ">" : " "} ${mark(milestone.status)} ${milestone.id} ${milestone.title}`);
		for (const feature of milestone.features) lines.push(`${selectedId === feature.id ? ">" : " "}   ${mark(feature.status)} ${feature.id} ${feature.title}`);
	}
	return lines;
}

function blockInspectionLines(block: MissionBlockMetadata): string[] {
	const artifactLines = block.artifactPaths.length > 0
		? block.artifactPaths.map((artifact) => `Artifact: ${artifact}`)
		: ["Artifact: none recorded; inspect the run directory directly."];
	return [
		"Block details",
		`Reason category: ${block.reasonCategory}`,
		`Failed item: ${block.kind} ${block.failedItemId} — ${block.failedItemTitle}`,
		`Run id: ${block.runId}`,
		`Run dir: ${block.runDir}`,
		`Exit code: ${block.exitCode}`,
		...(block.status ? [`Reported status: ${block.status}`] : []),
		...artifactLines,
		"Suggested inspection steps:",
		block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : "1. Read validation-report.json and validation-report.md if present.",
		"2. Inspect transcript.jsonl and stderr.txt in the run directory if artifacts are missing or incomplete.",
		"3. Decide whether to revise the mission plan, fix the implementation, or resume execution.",
	];
}

function missionDetailsLines(selection: MissionControlSelection, run?: MissionRunContext, block?: MissionBlockMetadata): string[] {
	const mission = selection.mission;
	const lines = ["Details"];
	if (selection.kind === "mission") {
		lines.push(`Mission: ${mission.title}`, `ID: ${mission.id}`, `Status: ${mission.status}`, `Created: ${mission.createdAt}`, `Updated: ${mission.updatedAt}`);
	} else if (selection.kind === "block") {
		lines.push(...blockInspectionLines(selection.block));
	} else if (selection.kind === "milestone") {
		lines.push(`Milestone: ${selection.milestone.id} — ${selection.milestone.title}`, `Status: ${selection.milestone.status}`);
		if (selection.milestone.objective) lines.push(`Objective: ${selection.milestone.objective}`);
		if (selection.milestone.validation) lines.push(`Validation: ${selection.milestone.validation}`);
		if (selection.milestone.validationRunId) lines.push(`Validation run: ${selection.milestone.validationRunId}`);
	} else {
		lines.push(`Feature: ${selection.feature.id} — ${selection.feature.title}`, `Milestone: ${selection.milestone.id} — ${selection.milestone.title}`, `Status: ${selection.feature.status}`);
		if (selection.feature.dependencies?.length) lines.push(`Dependencies: ${selection.feature.dependencies.join(", ")}`);
		if (selection.feature.runId) lines.push(`Run: ${selection.feature.runId}`);
		if (selection.feature.commit) lines.push(`Commit: ${selection.feature.commit}`);
		lines.push(`Description: ${selection.feature.description}`);
	}
	if (run) lines.push("", "Run context", `${run.label}: ${run.runId}`, `Item: ${run.kind} ${run.itemId} — ${run.itemTitle}`, `Artifacts: ${run.runDir}`, ...runArtifactSummaryLines(run));
	if (block && selection.kind !== "block") lines.push("", "Block context", ...blockInspectionLines(block));
	return lines;
}

function eventTimelineLines(mission: MissionState): string[] {
	const events = readMissionEvents(mission);
	const lines = ["Event timeline"];
	if (events.length === 0) return [...lines, "(no events recorded)"];
	for (const event of events) {
		const stamp = event.ts ? event.ts.replace(/^\d{4}-/, "").replace(/\.\d{3}Z$/, "Z") : "unknown time";
		lines.push(`${stamp}  ${event.type}${eventDataSummary(event.data)}`);
	}
	return lines;
}

function columnLines(left: string[], right: string[], width: number): string[] {
	if (width < 80) return [...left, "", ...right].map((line) => clipLine(line, width));
	const gap = "  ";
	const leftWidth = Math.max(28, Math.floor((width - gap.length) * 0.42));
	const rightWidth = Math.max(20, width - leftWidth - gap.length);
	const rows = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rows; i += 1) {
		const leftText = padLineToWidth(left[i] ?? "", leftWidth);
		lines.push(clipLine(`${leftText}${gap}${clipLine(right[i] ?? "", rightWidth)}`, width));
	}
	return lines;
}

interface MissionControlViewState {
	selectedId?: string;
	selectedRecentMissionId?: string;
	lastAutoFocusedBlockId?: string;
	showHelp: boolean;
	focus: "tree" | "timeline";
}

const MISSION_CONTROL_POLL_MS = 1500;

function missionControlHelpLines(): string[] {
	return [
		"Help",
		"↑/k: select previous mission tree item",
		"↓/j: select next mission tree item",
		"tab: cycle focus hint between tree and timeline",
		"r: refresh mission artifacts",
		"?: toggle this help",
		"q/esc: close Mission Control",
		"Mission Control is read-only; no mission state is changed by these keys.",
	];
}

function missionControlTarget(cwd: string, state: MissionOrchestratorSessionState | undefined, targetMissionId?: string): MissionState | undefined {
	if (targetMissionId) return loadMission(cwd, targetMissionId);
	return activeMissionFromState(cwd, state);
}

function missionControlLines(cwd: string, state: MissionOrchestratorSessionState | undefined, width: number, view: MissionControlViewState, targetMissionId?: string): string[] {
	let active: MissionState | undefined;
	try {
		active = missionControlTarget(cwd, state, targetMissionId);
	} catch {
		return ["Mission Control (read-only)", "", `Mission not found: ${targetMissionId}`, "", "q/esc close"].map((line) => clipLine(line, Math.max(20, width)));
	}
	const missions = active ? [active] : visibleMissions(cwd).slice(0, 10);
	const safeWidth = Math.max(20, width);
	if (active) {
		const block = latestBlockFromArtifacts(active);
		if (block) {
			const id = blockSelectionId(block);
			if (view.lastAutoFocusedBlockId !== id) {
				view.selectedId = id;
				view.lastAutoFocusedBlockId = id;
			}
		} else {
			view.lastAutoFocusedBlockId = undefined;
		}
		const selection = missionControlSelectionById(active, view.selectedId, block);
		view.selectedId = selectionId(selection);
		const run = currentOrLastRunContext(active);
		const focusText = view.focus === "tree" ? "Focus: mission tree" : "Focus: event timeline";
		return [
			...missionControlHeader(active, safeWidth),
			focusText,
			"",
			...columnLines(missionTreeLines(active, selection, block), missionDetailsLines(selection, run, block), safeWidth),
			"",
			...eventTimelineLines(active).map((line) => clipLine(line, safeWidth)),
			...(view.showHelp ? ["", ...missionControlHelpLines().map((line) => clipLine(line, safeWidth))] : []),
			"",
			clipLine(`q/esc close · ↑/↓/j/k move selection · tab focus · r refresh · ? help · auto-refresh ${MISSION_CONTROL_POLL_MS / 1000}s`, safeWidth),
		];
	}
	const lines = ["Mission Control (read-only)", "", "No active mission.", ""];
	if (missions.length > 0) {
		if (!view.selectedRecentMissionId || !missions.some((mission) => mission.id === view.selectedRecentMissionId)) view.selectedRecentMissionId = missions[0]?.id;
		lines.push("Recent visible missions:");
		for (const mission of missions) lines.push(`${mission.id === view.selectedRecentMissionId ? ">" : " "} ${mission.id}  ${mission.status}  ${progressText(mission)}  ${mission.title}`);
	} else {
		lines.push("No active or visible missions found.", "Start one with /missions [goal].");
	}
	if (view.showHelp) lines.push("", ...missionControlHelpLines());
	lines.push("", "q/esc close · ↑/↓/j/k move recent mission · r refresh · ? help");
	return lines.map((line) => clipLine(line, safeWidth));
}

function missionControlMoveRecentMission(cwd: string, selectedId: string | undefined, delta: number): string | undefined {
	const missions = visibleMissions(cwd).slice(0, 10);
	if (missions.length === 0) return undefined;
	const currentIndex = Math.max(0, missions.findIndex((mission) => mission.id === selectedId));
	const nextIndex = Math.min(missions.length - 1, Math.max(0, currentIndex + delta));
	return missions[nextIndex]?.id;
}

async function openMissionControl(ctx: ExtensionContext, state?: MissionOrchestratorSessionState, targetMissionId?: string): Promise<MissionCommandResult> {
	if (!ctx.hasUI) {
		const text = "Mission Control requires an interactive UI.";
		ctx.ui.notify(text, "warning");
		return { ok: false, text };
	}
	if (targetMissionId) {
		try {
			loadMission(ctx.cwd, targetMissionId);
		} catch {
			const text = `Mission not found: ${targetMissionId}`;
			ctx.ui.notify(text, "warning");
			return { ok: false, text };
		}
	}
	const view: MissionControlViewState = { showHelp: false, focus: "tree" };
	await ctx.ui.custom((tui, _theme, _keybindings, done) => {
		let closed = false;
		const poll = setInterval(() => {
			if (!closed) tui.requestRender();
		}, MISSION_CONTROL_POLL_MS);
		const close = () => {
			closed = true;
			clearInterval(poll);
			done(undefined);
		};
		return {
			render: (width: number) => missionControlLines(ctx.cwd, state, width, view, targetMissionId),
			invalidate: () => undefined,
			dispose: () => {
				closed = true;
				clearInterval(poll);
			},
			handleInput: (data: string) => {
				let active: MissionState | undefined;
				try {
					active = missionControlTarget(ctx.cwd, state, targetMissionId);
				} catch {
					active = undefined;
				}
				const moveBy = data === "k" || matchesKey(data, "up") || data === "\u001b[A" ? -1 : data === "j" || matchesKey(data, "down") || data === "\u001b[B" ? 1 : 0;
				if (data === "q" || matchesKey(data, "escape")) {
					close();
					return;
				}
				if (moveBy !== 0) {
					if (active) view.selectedId = moveMissionControlSelection(active, view.selectedId, moveBy);
					else view.selectedRecentMissionId = missionControlMoveRecentMission(ctx.cwd, view.selectedRecentMissionId, moveBy);
					tui.requestRender();
					return;
				}
				if (data === "\t" || matchesKey(data, "tab")) {
					view.focus = view.focus === "tree" ? "timeline" : "tree";
					tui.requestRender();
					return;
				}
				if (data === "r") {
					tui.requestRender();
					return;
				}
				if (data === "?") {
					view.showHelp = !view.showHelp;
					tui.requestRender();
				}
			},
		};
	});
	return { ok: true, text: "Mission Control closed." };
}

async function startMissionOrchestrator(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const goal = args.trim();
	const modelStatus = await applyGlobalOrchestratorModelDefault(ctx, pi);
	pi.appendEntry(PLANNING_KICKOFF_ENTRY, { schemaVersion: 1, cwd: ctx.cwd, goal, createdAt: nowIso(), orchestratorModelStatus: modelStatus });
	ctx.ui.notify("Mission orchestrator loaded in this session.", "info");
	pi.sendMessage({
		customType: "missions-planning-kickoff",
		display: false,
		content: missionPlanningKickoffContext(ctx.cwd, goal),
		details: { cwd: ctx.cwd, orchestratorModelStatus: modelStatus },
	}, { triggerTurn: true });
}

function persistedPlanStatus(incomingStatus: Status | undefined, existingMission?: MissionState): Status {
	const existingIsStartedOrTerminal = existingMission && existingMission.status !== "planning" && existingMission.status !== "planned";
	if (!existingIsStartedOrTerminal) return "planned";
	if (!incomingStatus || incomingStatus === "planning" || incomingStatus === "planned") return existingMission.status;
	return incomingStatus;
}

function createPlanningMission(cwd: string, requestedId?: string): MissionState {
	const id = requestedId || `mission-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
	return {
		schemaVersion: 1,
		id,
		title: "Planning...",
		status: "planning",
		createdAt: nowIso(),
		updatedAt: nowIso(),
		cwd,
		models: readMissionGlobalSettings(cwd).models,
		milestones: [],
	};
}

function featureStatusById(mission: MissionState): Map<string, ItemStatus> {
	const statuses = new Map<string, ItemStatus>();
	for (const milestone of mission.milestones) {
		for (const feature of milestone.features) statuses.set(feature.id, feature.status);
	}
	return statuses;
}

function areFeatureDependenciesSatisfied(feature: MissionFeature, statuses: Map<string, ItemStatus>): boolean {
	return (feature.dependencies ?? []).every((dependencyId) => {
		const dependencyStatus = statuses.get(dependencyId);
		return dependencyStatus === "complete" || dependencyStatus === "skipped";
	});
}

function findNextFeature(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	const statuses = featureStatusById(mission);
	for (const milestone of mission.milestones) {
		if (milestone.status === "complete" || milestone.status === "failed" || milestone.status === "skipped") continue;
		for (const feature of milestone.features) {
			if (feature.status === "pending" && areFeatureDependenciesSatisfied(feature, statuses)) return { milestone, feature };
		}
	}
	return undefined;
}

function shouldAutoResumeAfterPlanRevision(cwd: string, existingMission: MissionState | undefined, revisedMission: MissionState): boolean {
	if (!existingMission || existingMission.status !== "blocked") return false;
	if (!hasMissionExecutionStarted(cwd, existingMission)) return false;
	if (revisedMission.status === "planning" || revisedMission.status === "planned" || revisedMission.status === "complete" || revisedMission.status === "failed") return false;
	if (revisedMission.status === "paused") return false;
	return Boolean(findNextFeature(revisedMission));
}

async function runWorker(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone, feature: MissionFeature): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-worker-${feature.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	feature.status = "running";
	feature.runId = runId;
	mission.status = "running";
	mission.currentMilestoneId = milestone.id;
	mission.currentFeatureId = feature.id;
	milestone.status = "running";
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
	appendEvent(dir, "worker_started", { milestoneId: milestone.id, featureId: feature.id, runId });

	const prompt = `Use the mission-worker skill and the mission-specific worker skill if present. Implement exactly one mission feature.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature: ${feature.id} - ${feature.title}\n\nFeature description:\n${feature.description}\n\nRequired outputs: commit code changes with git, then write handoff.json and handoff.md in the run directory. If blocked, write handoff files explaining why.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		prompt,
		model: resolveRoleModel(mission.cwd, mission, "worker"),
		systemPromptFiles: [BASE_SKILLS.worker, path.join(dir, "skills/worker/SKILL.md")],
		transcriptFile: path.join(runDir, "transcript.jsonl"),
		signal: ctx.signal,
		onUpdate: (text) => ctx.ui.setWidget("missions-run", [`Worker ${feature.id}: ${feature.title}`, ...text.split("\n").slice(-7)]),
	});
	fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
	appendEvent(dir, "worker_finished", { featureId: feature.id, runId, exitCode: result.exitCode });

	let handoff: any = undefined;
	const handoffFile = path.join(runDir, "handoff.json");
	if (fs.existsSync(handoffFile)) {
		try {
			handoff = readJson<any>(handoffFile);
		} catch (error) {
			appendEvent(dir, "handoff_parse_error", { featureId: feature.id, error: String(error) });
		}
	}
	const dirty = await gitPorcelain(mission.cwd);
	const head = await gitHead(mission.cwd);
	feature.commit = handoff?.commit || head;
	let block: MissionBlockSummary | undefined;
	if (result.exitCode !== 0 || !handoff || dirty) {
		feature.status = "failed";
		mission.status = "blocked";
		appendEvent(dir, "worker_failed", { featureId: feature.id, dirty, hasHandoff: Boolean(handoff) });
		block = {
			kind: "worker",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: handoff?.status ?? (!handoff ? "missing handoff" : undefined),
			dirty: dirty || undefined,
			artifactPaths: existingPaths([handoffFile, path.join(runDir, "handoff.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	} else if (handoff.status === "complete") {
		feature.status = "complete";
	} else {
		feature.status = handoff.status === "blocked" ? "failed" : "failed";
		mission.status = "blocked";
		block = {
			kind: "worker",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			featureId: feature.id,
			featureTitle: feature.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: handoff.status,
			artifactPaths: existingPaths([handoffFile, path.join(runDir, "handoff.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	}
	if (block) persistMissionBlock(dir, mission, block, classifyWorkerBlock(result, handoff, dirty));
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
	return block;
}

function completedFeatureReviewContext(dir: string, milestone: MissionMilestone): string {
	const completedFeatures = milestone.features.filter((feature) => feature.status === "complete");
	if (completedFeatures.length === 0) return "Completed features available for code review: none recorded.";
	const lines = ["Completed features available for code review:"];
	for (const feature of completedFeatures) {
		const runDir = feature.runId ? path.join(dir, "runs", feature.runId) : undefined;
		const handoffJson = runDir ? path.join(runDir, "handoff.json") : undefined;
		const handoffMd = runDir ? path.join(runDir, "handoff.md") : undefined;
		lines.push(`- ${feature.id} - ${feature.title}`);
		lines.push(`  status: ${feature.status}`);
		lines.push(`  commit: ${feature.commit ?? "not recorded"}`);
		lines.push(`  worker run: ${feature.runId ?? "not recorded"}`);
		lines.push(`  run directory: ${runDir ?? "not recorded"}`);
		lines.push(`  handoff.json: ${handoffJson && fs.existsSync(handoffJson) ? handoffJson : "not available"}`);
		lines.push(`  handoff.md: ${handoffMd && fs.existsSync(handoffMd) ? handoffMd : "not available"}`);
	}
	return lines.join("\n");
}

async function runValidator(ctx: ExtensionContext, mission: MissionState, milestone: MissionMilestone): Promise<MissionBlockSummary | undefined> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-validator-${milestone.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	milestone.validationRunId = runId;
	milestone.status = "running";
	mission.status = "running";
	mission.currentMilestoneId = milestone.id;
	mission.currentFeatureId = undefined;
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
	appendEvent(dir, "validator_started", { milestoneId: milestone.id, runId });
	const featureReviewContext = completedFeatureReviewContext(dir, milestone);
	const prompt = `Use the mission-validator skill and the mission-specific scrutiny validator skill if present. Validate this completed milestone adversarially.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\n\n${featureReviewContext}\n\nPerform a per-feature adversarial code review for each completed feature listed above, using the recorded commits and handoff paths where available. Inspect relevant diffs/handoffs, assess whether tests and procedure were adequate, and report code-review defects or procedure findings. Also check the milestone against the validation contract and mission plan. Run appropriate checks. Write validation-report.json and validation-report.md in the run directory.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		prompt,
		model: resolveRoleModel(mission.cwd, mission, "validator"),
		systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-scrutiny/SKILL.md")],
		transcriptFile: path.join(runDir, "transcript.jsonl"),
		signal: ctx.signal,
		onUpdate: (text) => ctx.ui.setWidget("missions-run", [`Validator ${milestone.id}: ${milestone.title}`, ...text.split("\n").slice(-7)]),
	});
	fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
	let report: any = undefined;
	const reportFile = path.join(runDir, "validation-report.json");
	if (fs.existsSync(reportFile)) {
		try {
			report = readJson<any>(reportFile);
		} catch (error) {
			appendEvent(dir, "validation_parse_error", { milestoneId: milestone.id, error: String(error) });
		}
	}
	let block: MissionBlockSummary | undefined;
	if (result.exitCode === 0 && report?.status === "pass") {
		milestone.status = "complete";
	} else {
		milestone.status = "failed";
		mission.status = "blocked";
		block = {
			kind: "validator",
			missionId: mission.id,
			missionTitle: mission.title,
			milestoneId: milestone.id,
			milestoneTitle: milestone.title,
			runId,
			runDir,
			exitCode: result.exitCode,
			status: report?.status ?? (!report ? "missing validation report" : undefined),
			artifactPaths: existingPaths([reportFile, path.join(runDir, "validation-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
		};
	}
	if (block) persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
	appendEvent(dir, "validator_finished", { milestoneId: milestone.id, runId, exitCode: result.exitCode, status: report?.status });
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
	return block;
}

// Mission Control concurrency decision (F1/F7): ctx.ui.custom() returns a Promise
// that settles only when the custom component calls done()/closes, so awaiting it
// before or during runMission would make mission execution wait for the user to
// close the UI. Auto-open Mission Control fire-and-forget and keep runMission as
// the durable execution owner. Closing Mission Control only disposes the read-only
// UI; it does not abort ctx.signal or any child worker/validator process.
function autoOpenMissionControl(ctx: ExtensionContext, mission: MissionState): void {
	if (!ctx.hasUI) return;
	const state = buildOrchestratorState(ctx.cwd, mission, {
		activeMissionId: mission.id,
		activePlanningMissionId: undefined,
		activeRunningMissionId: mission.id,
	});
	void openMissionControl(ctx, state).catch((error) => {
		ctx.ui.notify(`Mission Control failed to open: ${error instanceof Error ? error.message : String(error)}`, "warning");
	});
}

async function runMission(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const id = args.trim() || latestMission(ctx.cwd)?.id;
	if (!id) {
		ctx.ui.notify("No mission found. Start with /missions [goal] and persist a plan first.", "warning");
		return;
	}
	let mission = loadMission(ctx.cwd, id);
	const dir = missionDir(ctx.cwd, id);
	if (mission.status === "planning") {
		ctx.ui.notify("Mission is still in interactive planning. Ask the orchestrator to persist a runnable plan first.", "warning");
		return;
	}
	if (mission.status === "complete") {
		ctx.ui.notify("Mission is already complete.", "info");
		return;
	}
	if (await gitPorcelain(mission.cwd)) {
		const ok = await ctx.ui.confirm("Dirty git status", "Repository has uncommitted changes. Continue anyway? Workers must leave it clean after each feature.");
		if (!ok) return;
	}
	if (!hasMissionExecutionStarted(ctx.cwd, mission)) {
		mission = markMissionExecutionStarted(mission);
		saveMission(ctx.cwd, mission);
		appendEvent(dir, "mission_execution_started", { missionId: mission.id });
	}
	autoOpenMissionControl(ctx, mission);
	ctx.ui.notify(`Running mission ${mission.title}`, "info");
	while (true) {
		mission = loadMission(ctx.cwd, id);
		const next = findNextFeature(mission);
		if (!next) break;
		const workerBlock = await runWorker(ctx, mission, next.milestone, next.feature);
		mission = loadMission(ctx.cwd, id);
		if (mission.status === "blocked" || mission.status === "failed") {
			if (workerBlock) emitMissionBlockMessage(pi, workerBlock);
			ctx.ui.notify(`Mission blocked. See ${dir}`, "error");
			ctx.ui.setWidget("missions-run", undefined);
			return;
		}
		const milestone = mission.milestones.find((m) => m.id === next.milestone.id)!;
		if (milestone.features.every((f) => f.status === "complete" || f.status === "skipped")) {
			const validatorBlock = await runValidator(ctx, mission, milestone);
			mission = loadMission(ctx.cwd, id);
			if (mission.status === "blocked" || mission.status === "failed") {
				if (validatorBlock) emitMissionBlockMessage(pi, validatorBlock);
				ctx.ui.notify(`Validation blocked mission. See ${dir}`, "error");
				ctx.ui.setWidget("missions-run", undefined);
				return;
			}
		}
	}
	mission = loadMission(ctx.cwd, id);
	mission.status = "complete";
	for (const m of mission.milestones) if (m.status !== "complete") m.status = "complete";
	saveMission(ctx.cwd, mission);
	appendEvent(dir, "mission_complete", {});
	updateWidget(ctx, mission);
	ctx.ui.setWidget("missions-run", undefined);
	ctx.ui.notify(`Mission complete: ${mission.title}`, "info");
}

export default function missionsExtension(pi: ExtensionAPI): void {
	let orchestratorState: MissionOrchestratorSessionState | undefined;
	let activePlanningId: string | undefined;
	let activeMissionId: string | undefined;
	let activeRunningId: string | undefined;

	const persistOrchestratorState = (cwd: string, mission?: MissionState, overrides: Partial<MissionOrchestratorSessionState> = {}) => {
		const hasOverride = (key: keyof MissionOrchestratorSessionState) => Object.prototype.hasOwnProperty.call(overrides, key);
		orchestratorState = buildOrchestratorState(cwd, mission, {
			...overrides,
			activeMissionId: hasOverride("activeMissionId") ? overrides.activeMissionId : mission?.id ?? activeMissionId,
			activePlanningMissionId: hasOverride("activePlanningMissionId") ? overrides.activePlanningMissionId : activePlanningId,
			activeRunningMissionId: hasOverride("activeRunningMissionId") ? overrides.activeRunningMissionId : activeRunningId,
		});
		activeMissionId = orchestratorState.activeMissionId;
		activePlanningId = orchestratorState.activePlanningMissionId;
		activeRunningId = orchestratorState.activeRunningMissionId;
		pi.appendEntry(ORCHESTRATOR_STATE_ENTRY, orchestratorState);
	};

	pi.registerTool({
		name: "mission_start_execution",
		label: "Start Mission Execution",
		description: "Ask the user for explicit confirmation, then start or resume sequential mission execution on their behalf. Omit missionId to use the current session's active mission.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const missionId = params.missionId || activeMissionId || activePlanningId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
			if (!missionId) {
				return { content: [{ type: "text", text: "No mission found to run." }], details: {}, isError: true };
			}
			const mission = loadMission(ctx.cwd, missionId);
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Explicit confirmation requires an interactive UI." }], details: { missionId }, isError: true };
			}
			const ok = await ctx.ui.confirm("Start mission execution?", `${mission.title}\n\nThis will run mission ${missionId} now. Workers may modify files and create commits.`);
			if (!ok) return { content: [{ type: "text", text: "Mission start canceled by user." }], details: { missionId } };
			activeRunningId = missionId;
			persistOrchestratorState(ctx.cwd, mission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: missionId });
			await runMission(missionId, ctx, pi);
			persistOrchestratorState(ctx.cwd, loadMission(ctx.cwd, missionId), { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: undefined });
			return { content: [{ type: "text", text: `Started or resumed mission ${missionId}.` }], details: { missionId } };
		},
	});

	pi.registerTool({
		name: "mission_write_plan",
		label: "Write or Revise Mission Plan",
		description: "Persist the current interactive mission planning draft or revise the active mission plan. Omit missionId to use the current session's active planning/running mission; never-started missions are not run, but previously-started blocked missions auto-resume when a revision leaves pending runnable work.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
			mission: Type.Any({ description: "Complete mission.json object matching the mission-orchestrator schema." }),
			objectiveMd: Type.String({ description: "Human-readable objective, constraints, non-goals, and assumptions." }),
			featuresJson: Type.Any({ description: "Ordered features grouped by milestone. Usually same milestone/feature content as mission.milestones." }),
			validationContractJson: Type.Any({ description: "Implementation-independent validation assertions." }),
			validationContractMd: Type.String({ description: "Human-readable validation contract." }),
			workerSkillMd: Type.String({ description: "Mission-specific worker SKILL.md content." }),
			validatorScrutinySkillMd: Type.String({ description: "Mission-specific scrutiny validator SKILL.md content." }),
			validatorUserTestingSkillMd: Type.Optional(Type.String({ description: "Mission-specific QA/user-testing validator SKILL.md content, if applicable." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = activeMissionFromState(ctx.cwd, orchestratorState);
			const requestedMission = params.mission as Partial<MissionState>;
			const missionId = params.missionId || activePlanningId || activeMissionId || active?.id || requestedMission.id || createPlanningMission(ctx.cwd).id;
			const dir = missionDir(ctx.cwd, missionId);
			const existingMission = fs.existsSync(path.join(dir, "mission.json")) ? loadMission(ctx.cwd, missionId) : undefined;
			const seedMission = existingMission ?? createPlanningMission(ctx.cwd, missionId);
			ensureDir(path.join(dir, "plan"));
			ensureDir(path.join(dir, "skills/worker"));
			ensureDir(path.join(dir, "skills/validator-scrutiny"));
			ensureDir(path.join(dir, "skills/validator-user-testing"));
			const mission = params.mission as MissionState;
			mission.id = missionId;
			mission.cwd = ctx.cwd;
			mission.schemaVersion = 1;
			mission.status = persistedPlanStatus(mission.status, existingMission);
			mission.updatedAt = nowIso();
			if (!mission.createdAt) mission.createdAt = seedMission.createdAt;
			mission.models = normalizeRoleModels(mission.models ?? seedMission.models);
			if (existingMission && !mission.executionStartedAt && hasMissionExecutionStarted(ctx.cwd, existingMission)) mission.executionStartedAt = existingMission.executionStartedAt ?? nowIso();
			if (!existingMission) {
				const globalModels = readMissionGlobalSettings(ctx.cwd).models;
				for (const role of MISSION_ROLES) if (mission.models[role] === "default") mission.models[role] = globalModels[role];
			}
			writeJson(path.join(dir, "mission.json"), mission);
			fs.writeFileSync(path.join(dir, "plan/objective.md"), params.objectiveMd);
			writeJson(path.join(dir, "plan/features.json"), params.featuresJson);
			writeJson(path.join(dir, "plan/validation-contract.json"), params.validationContractJson);
			fs.writeFileSync(path.join(dir, "plan/validation-contract.md"), params.validationContractMd);
			fs.writeFileSync(path.join(dir, "skills/worker/SKILL.md"), params.workerSkillMd);
			fs.writeFileSync(path.join(dir, "skills/validator-scrutiny/SKILL.md"), params.validatorScrutinySkillMd);
			if (params.validatorUserTestingSkillMd) fs.writeFileSync(path.join(dir, "skills/validator-user-testing/SKILL.md"), params.validatorUserTestingSkillMd);
			const autoResume = shouldAutoResumeAfterPlanRevision(ctx.cwd, existingMission, mission);
			appendEvent(dir, existingMission ? "interactive_plan_revised" : "interactive_plan_written", { title: mission.title, milestones: mission.milestones?.length ?? 0, status: mission.status, autoResume });
			updateWidget(ctx, mission);
			persistOrchestratorState(ctx.cwd, mission, {
				activeMissionId: missionId,
				activePlanningMissionId: mission.status === "planning" ? missionId : undefined,
				activeRunningMissionId: autoResume || mission.status === "running" || mission.status === "paused" ? missionId : undefined,
			});
			let text = persistedPlanSummary(mission, dir, params.objectiveMd, params.validationContractJson, Boolean(existingMission));
			if (autoResume) {
				ctx.ui.notify(`Recovery plan saved; auto-resuming mission ${missionId}.`, "info");
				appendEvent(dir, "mission_auto_resume_after_plan_revision", { missionId });
				activeRunningId = missionId;
				await runMission(missionId, ctx, pi);
				const resumedMission = loadMission(ctx.cwd, missionId);
				persistOrchestratorState(ctx.cwd, resumedMission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: undefined });
				text = `${text}\n\nAuto-resumed mission execution because this revision unblocked a previously started mission with pending work.`;
			}
			return { content: [{ type: "text", text }], details: { missionId, dir, autoResumed: autoResume } };
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const content = lightweightMissionContext(ctx.cwd, orchestratorState);
		if (!content) return;
		return {
			message: {
				customType: "missions-orchestrator-context",
				display: false,
				content,
			},
		};
	});

	const handleMissions = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<MissionCommandResult> => {
		const [subcommand, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
		const args = rest.join(" ");
		try {
			if (!subcommand || subcommand === "new" || !["status", "run", "resume", "list", "clear", "models"].includes(subcommand)) {
				const goal = subcommand === "new" ? args : rawArgs.trim();
				await startMissionOrchestrator(goal, ctx, pi);
				return { ok: true, text: "Mission orchestrator loaded." };
			}
			if (subcommand === "models") {
				const modelArgs = args.split(/\s+/).filter(Boolean);
				if (modelArgs[0] === "set") modelArgs.shift();
				const [roleArg, ...modelParts] = modelArgs;
				if (!roleArg) {
					const text = formatGlobalModels(ctx.cwd);
					ctx.ui.notify(text, "info");
					return { ok: true, text, details: { settingsFile: globalSettingsFile(ctx.cwd), models: readMissionGlobalSettings(ctx.cwd).models } };
				}
				if (!isMissionRole(roleArg)) {
					const text = `Unknown mission model role '${roleArg}'. Expected one of: ${MISSION_ROLES.join(", ")}.`;
					ctx.ui.notify(text, "warning");
					return { ok: false, text };
				}
				const model = modelParts.join(" ").trim();
				if (!model) {
					const current = readMissionGlobalSettings(ctx.cwd).models[roleArg];
					const text = `${roleArg}: ${current}\n\nSet with: /missions models ${roleArg} <model> (or /missions models set ${roleArg} <model>)`;
					ctx.ui.notify(text, "info");
					return { ok: true, text, details: { role: roleArg, model: current } };
				}
				const text = setGlobalModel(ctx.cwd, roleArg, model);
				ctx.ui.notify(text, "info");
				return { ok: true, text, details: { settingsFile: globalSettingsFile(ctx.cwd), models: readMissionGlobalSettings(ctx.cwd).models } };
			}
			if (subcommand === "status") {
				const mission = resolveMission(ctx.cwd, args || undefined, orchestratorState);
				if (!mission) {
					ctx.ui.notify("No missions found.", "info");
					return { ok: false, text: "No missions found." };
				}
				updateWidget(ctx, mission);
				const text = summarizeMission(mission);
				ctx.ui.notify(text, "info");
				return { ok: true, text, details: { missionId: mission.id } };
			}
			if (subcommand === "run" || subcommand === "resume") {
				const id = args || activeMissionId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
				if (id) {
					activeRunningId = id;
					persistOrchestratorState(ctx.cwd, loadMission(ctx.cwd, id), { activeMissionId: id, activePlanningMissionId: undefined, activeRunningMissionId: id });
				}
				await runMission(args || id || "", ctx, pi);
				if (id) persistOrchestratorState(ctx.cwd, loadMission(ctx.cwd, id), { activeMissionId: id, activePlanningMissionId: undefined, activeRunningMissionId: undefined });
				return { ok: true, text: "Mission run command completed." };
			}
			if (subcommand === "list") {
				const text = missionListText(ctx.cwd);
				ctx.ui.notify(text, "info");
				return { ok: true, text };
			}
			if (subcommand === "clear") {
				const completedCount = listMissions(ctx.cwd).filter((mission) => mission.status === "complete" && !isMissionCleared(ctx.cwd, mission.id)).length;
				if (completedCount > 0) {
					const ok = await ctx.ui.confirm("Clear completed missions?", `This will hide ${completedCount} completed mission${completedCount === 1 ? "" : "s"} from default mission UI. Artifacts will not be deleted and statuses will remain complete.`);
					if (!ok) {
						const text = "Mission clear canceled by user.";
						ctx.ui.notify(text, "info");
						return { ok: true, text, details: { clearedIds: [] } };
					}
				}
				const result = clearCompletedMissions(ctx.cwd);
				ctx.ui.notify(result.text, result.clearedIds.length > 0 ? "info" : "warning");
				updateWidget(ctx, activeMissionFromState(ctx.cwd, orchestratorState) ?? latestVisibleMission(ctx.cwd));
				return { ok: true, text: result.text, details: result };
			}
			const usage = "Usage: /missions [goal] | /missions new [goal] | /missions run [id] | /missions status [id] | /missions list | /missions clear | /missions models [set] [role] [model]";
			ctx.ui.notify(usage, "warning");
			return { ok: false, text: usage };
		} catch (error) {
			const text = `missions error: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(text, "error");
			return { ok: false, text };
		}
	};

	pi.registerTool({
		name: "mission_status",
		label: "Show Mission Status",
		description: "Show mission status on the user's behalf. Read-only; no confirmation required. Omit missionId to use the current session's active mission, with the same summary semantics as /missions status.",
		parameters: Type.Object({
			missionId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mission = resolveMission(ctx.cwd, params.missionId, orchestratorState);
			if (!mission) return { content: [{ type: "text", text: "No missions found." }], details: {}, isError: true };
			updateWidget(ctx, mission);
			const text = summarizeMission(mission);
			ctx.ui.notify(text, "info");
			return { content: [{ type: "text", text }], details: { missionId: mission.id } };
		},
	});

	pi.registerTool({
		name: "mission_list",
		label: "List Missions",
		description: "List missions on the user's behalf. Read-only; no confirmation required. Uses the same listing semantics as /missions list.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const text = missionListText(ctx.cwd);
			ctx.ui.notify(text, "info");
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "mission_clear_completed",
		label: "Clear Completed Missions",
		description: "Ask for explicit confirmation, then clear completed missions on the user's behalf using the same backing behavior as /missions clear.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Explicit confirmation requires an interactive UI." }], details: {}, isError: true };
			}
			const completedCount = listMissions(ctx.cwd).filter((mission) => mission.status === "complete" && !isMissionCleared(ctx.cwd, mission.id)).length;
			const ok = await ctx.ui.confirm("Clear completed missions?", `This will hide ${completedCount} completed mission${completedCount === 1 ? "" : "s"} from default mission UI. Artifacts will not be deleted and statuses will remain complete.`);
			if (!ok) return { content: [{ type: "text", text: "Mission clear canceled by user." }], details: { clearedIds: [] } };
			try {
				const result = clearCompletedMissions(ctx.cwd);
				ctx.ui.notify(result.text, result.clearedIds.length > 0 ? "info" : "warning");
				updateWidget(ctx, activeMissionFromState(ctx.cwd, orchestratorState) ?? latestVisibleMission(ctx.cwd));
				return { content: [{ type: "text", text: result.text }], details: result };
			} catch (error) {
				const text = `missions clear failed: ${error instanceof Error ? error.message : String(error)}`;
				ctx.ui.notify(text, "error");
				return { content: [{ type: "text", text }], details: {}, isError: true };
			}
		},
	});

	pi.registerCommand("missions", {
		description: "Plan and run long sequential missions (/missions [goal]|run|status|list|clear|models)",
		handler: async (args, ctx) => { await handleMissions(args, ctx); },
	});

	pi.registerCommand("mission-control", {
		description: "Open read-only interactive Mission Control",
		handler: async (args, ctx) => {
			const targetMissionId = args.trim() || undefined;
			await openMissionControl(ctx, orchestratorState, targetMissionId);
		},
	});

	pi.registerCommand("mission", {
		description: "Alias for /missions",
		handler: async (args, ctx) => { await handleMissions(args, ctx); },
	});

	pi.on("session_start", async (_event, ctx) => {
		orchestratorState = latestOrchestratorStateFromSession(ctx.cwd, ctx.sessionManager.getEntries());
		const active = activeMissionFromState(ctx.cwd, orchestratorState);
		if (!orchestratorState && active) orchestratorState = buildOrchestratorState(ctx.cwd, active);
		activeMissionId = active?.id ?? orchestratorState?.activeMissionId;
		activePlanningId = active?.status === "planning" ? active.id : orchestratorState?.activePlanningMissionId;
		activeRunningId = active?.status === "running" || active?.status === "paused" ? active.id : orchestratorState?.activeRunningMissionId;
		if (active && (!orchestratorState?.context || orchestratorState.context.id !== active.id || orchestratorState.context.status !== active.status)) {
			persistOrchestratorState(ctx.cwd, active, { activeMissionId: active.id, activePlanningMissionId: activePlanningId, activeRunningMissionId: activeRunningId });
		}
		updateWidget(ctx, active ?? latestVisibleMission(ctx.cwd));
	});
}
