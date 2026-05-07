import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	models: { orchestrator: string; worker: string; validator: string };
	currentMilestoneId?: string;
	currentFeatureId?: string;
	milestones: MissionMilestone[];
}

interface RunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	finalText: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function missionRoot(cwd: string): string {
	return path.join(cwd, ".pi", "missions");
}

function missionDir(cwd: string, id: string): string {
	return path.join(missionRoot(cwd), id);
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

function loadMission(cwd: string, id: string): MissionState {
	return readJson<MissionState>(path.join(missionDir(cwd, id), "mission.json"));
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
		.map((file) => readJson<MissionState>(file))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function latestMission(cwd: string): MissionState | undefined {
	return listMissions(cwd)[0];
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

function updateWidget(ctx: ExtensionContext, mission?: MissionState): void {
	if (!mission) {
		ctx.ui.setStatus("missions", undefined);
		ctx.ui.setWidget("missions", undefined);
		return;
	}
	const features = mission.milestones.flatMap((m) => m.features);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	ctx.ui.setStatus("missions", `🚀 ${done}/${features.length} ${mission.status}`);
	const lines = [`Mission: ${mission.title} (${mission.status})`];
	for (const m of mission.milestones.slice(0, 4)) {
		lines.push(`${mark(m.status)} ${m.id} ${m.title}`);
		for (const f of m.features.slice(0, 4)) lines.push(`  ${mark(f.status)} ${f.id} ${f.title}`);
	}
	ctx.ui.setWidget("missions", lines);
}

function mark(status: string): string {
	if (status === "complete") return "✓";
	if (status === "running") return "⏳";
	if (status === "failed" || status === "blocked") return "✗";
	if (status === "skipped") return "↷";
	return "○";
}

function summarizeMission(mission: MissionState): string {
	const features = mission.milestones.flatMap((m) => m.features);
	const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
	return [
		`Mission: ${mission.title}`,
		`ID: ${mission.id}`,
		`Status: ${mission.status}`,
		`Progress: ${done}/${features.length} features`,
		`Dir: ${missionDir(mission.cwd, mission.id)}`,
		"",
		...mission.milestones.flatMap((m) => [
			`${mark(m.status)} ${m.id}: ${m.title}`,
			...m.features.map((f) => `  ${mark(f.status)} ${f.id}: ${f.title}${f.commit ? ` (${f.commit})` : ""}`),
		]),
	].join("\n");
}

async function createMission(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, setActivePlanning: (id: string) => void): Promise<void> {
	const editedGoal = args.trim() || (await ctx.ui.editor("Mission goal", ""));
	const goal = editedGoal ?? "";
	if (!goal.trim()) {
		ctx.ui.notify("Mission creation canceled: no goal provided.", "warning");
		return;
	}

	const id = `mission-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
	const dir = missionDir(ctx.cwd, id);
	ensureDir(path.join(dir, "plan"));
	ensureDir(path.join(dir, "skills"));
	ensureDir(path.join(dir, "runs"));
	const seed: MissionState = {
		schemaVersion: 1,
		id,
		title: "Planning...",
		status: "planning",
		createdAt: nowIso(),
		updatedAt: nowIso(),
		cwd: ctx.cwd,
		models: { orchestrator: "default", worker: "default", validator: "default" },
		milestones: [],
	};
	writeJson(path.join(dir, "mission.json"), seed);
	fs.writeFileSync(path.join(dir, "plan", "objective.md"), `# Mission Goal\n\n${goal}\n`);
	appendEvent(dir, "interactive_planning_started", { goal });
	setActivePlanning(id);
	updateWidget(ctx, seed);
	ctx.ui.notify(`Interactive mission planning started: ${id}\n${dir}`, "info");

	pi.sendUserMessage(
		`Use the mission-orchestrator skill. We are now interactively planning mission ${id}.\n\nMission directory: ${dir}\nTarget repository cwd: ${ctx.cwd}\nCurrent time: ${nowIso()}\n\nUser goal:\n${goal}\n\nDo not write application code. Collaborate with the user: ask clarifying questions, push back on scope, propose milestones/features, and draft a pre-implementation validation contract. When the plan is ready, call mission_write_plan to persist the current draft. Tell the user to run /missions approve ${id} only after they are satisfied.`,
	);
}

function findNextFeature(mission: MissionState): { milestone: MissionMilestone; feature: MissionFeature } | undefined {
	for (const milestone of mission.milestones) {
		for (const feature of milestone.features) {
			if (feature.status === "pending") return { milestone, feature };
		}
	}
	return undefined;
}

async function runWorker(ctx: ExtensionCommandContext, mission: MissionState, milestone: MissionMilestone, feature: MissionFeature): Promise<void> {
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
		model: mission.models.worker,
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
	if (result.exitCode !== 0 || !handoff || dirty) {
		feature.status = "failed";
		mission.status = "blocked";
		appendEvent(dir, "worker_failed", { featureId: feature.id, dirty, hasHandoff: Boolean(handoff) });
	} else if (handoff.status === "complete") {
		feature.status = "complete";
	} else {
		feature.status = handoff.status === "blocked" ? "failed" : "failed";
		mission.status = "blocked";
	}
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
}

async function runValidator(ctx: ExtensionCommandContext, mission: MissionState, milestone: MissionMilestone): Promise<void> {
	const dir = missionDir(mission.cwd, mission.id);
	const runId = `${String(Date.now())}-validator-${milestone.id}`;
	const runDir = path.join(dir, "runs", runId);
	ensureDir(runDir);
	milestone.validationRunId = runId;
	appendEvent(dir, "validator_started", { milestoneId: milestone.id, runId });
	const prompt = `Use the mission-validator skill and the mission-specific scrutiny validator skill if present. Validate this completed milestone adversarially.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\n\nRead the validation contract, mission plan, and worker handoffs. Run appropriate checks. Write validation-report.json and validation-report.md in the run directory.`;
	const result = await runPiChild({
		cwd: mission.cwd,
		prompt,
		model: mission.models.validator,
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
	if (result.exitCode === 0 && report?.status === "pass") {
		milestone.status = "complete";
	} else {
		milestone.status = "failed";
		mission.status = "blocked";
	}
	appendEvent(dir, "validator_finished", { milestoneId: milestone.id, runId, exitCode: result.exitCode, status: report?.status });
	saveMission(ctx.cwd, mission);
	updateWidget(ctx, mission);
}

async function runMission(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const id = args.trim() || latestMission(ctx.cwd)?.id;
	if (!id) {
		ctx.ui.notify("No mission found. Start with /missions new", "warning");
		return;
	}
	let mission = loadMission(ctx.cwd, id);
	const dir = missionDir(ctx.cwd, id);
	if (mission.status === "planning") {
		ctx.ui.notify(`Mission is still in interactive planning. Approve it first with /missions approve ${id}.`, "warning");
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
	ctx.ui.notify(`Running mission ${mission.title}`, "info");
	while (true) {
		mission = loadMission(ctx.cwd, id);
		const next = findNextFeature(mission);
		if (!next) break;
		await runWorker(ctx, mission, next.milestone, next.feature);
		mission = loadMission(ctx.cwd, id);
		if (mission.status === "blocked" || mission.status === "failed") {
			ctx.ui.notify(`Mission blocked. See ${dir}`, "error");
			ctx.ui.setWidget("missions-run", undefined);
			return;
		}
		const milestone = mission.milestones.find((m) => m.id === next.milestone.id)!;
		if (milestone.features.every((f) => f.status === "complete" || f.status === "skipped")) {
			await runValidator(ctx, mission, milestone);
			mission = loadMission(ctx.cwd, id);
			if (mission.status === "blocked" || mission.status === "failed") {
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
	let activePlanningId: string | undefined;
	const setActivePlanning = (id: string | undefined) => {
		activePlanningId = id;
		pi.appendEntry("missions-active-planning", { id });
	};

	pi.registerTool({
		name: "mission_write_plan",
		label: "Write Mission Plan",
		description: "Persist the current interactive mission planning draft. Use during /missions planning after collaborating with the user; this does not approve or run the mission.",
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
			const missionId = params.missionId || activePlanningId;
			if (!missionId) {
				return { content: [{ type: "text", text: "No active planning mission. Run /missions new first or provide missionId." }], details: {}, isError: true };
			}
			const dir = missionDir(ctx.cwd, missionId);
			ensureDir(path.join(dir, "plan"));
			ensureDir(path.join(dir, "skills/worker"));
			ensureDir(path.join(dir, "skills/validator-scrutiny"));
			ensureDir(path.join(dir, "skills/validator-user-testing"));
			const mission = params.mission as MissionState;
			mission.id = missionId;
			mission.cwd = ctx.cwd;
			mission.status = "planning";
			mission.updatedAt = nowIso();
			if (!mission.createdAt) mission.createdAt = nowIso();
			if (!mission.models) mission.models = { orchestrator: "default", worker: "default", validator: "default" };
			writeJson(path.join(dir, "mission.json"), mission);
			fs.writeFileSync(path.join(dir, "plan/objective.md"), params.objectiveMd);
			writeJson(path.join(dir, "plan/features.json"), params.featuresJson);
			writeJson(path.join(dir, "plan/validation-contract.json"), params.validationContractJson);
			fs.writeFileSync(path.join(dir, "plan/validation-contract.md"), params.validationContractMd);
			fs.writeFileSync(path.join(dir, "skills/worker/SKILL.md"), params.workerSkillMd);
			fs.writeFileSync(path.join(dir, "skills/validator-scrutiny/SKILL.md"), params.validatorScrutinySkillMd);
			if (params.validatorUserTestingSkillMd) fs.writeFileSync(path.join(dir, "skills/validator-user-testing/SKILL.md"), params.validatorUserTestingSkillMd);
			appendEvent(dir, "interactive_plan_written", { title: mission.title, milestones: mission.milestones?.length ?? 0 });
			updateWidget(ctx, mission);
			return { content: [{ type: "text", text: `Mission plan draft written to ${dir}. User can continue refining or run /missions approve ${missionId}.` }], details: { missionId, dir } };
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!activePlanningId) return;
		const dir = missionDir(ctx.cwd, activePlanningId);
		return {
			message: {
				customType: "missions-planning-context",
				display: false,
				content: `[MISSION PLANNING MODE]\nMission id: ${activePlanningId}\nMission directory: ${dir}\n\nYou are the interactive mission orchestrator. Use the mission-orchestrator skill. Collaborate with the user before execution: ask clarifying questions, refine milestones/features, create a pre-implementation validation contract, and generate mission-specific worker/validator skills. Do not modify application code. Use mission_write_plan whenever the draft should be persisted. The user must approve with /missions approve before workers run.`,
			},
		};
	});

	const handleMissions = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		const [subcommand, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
		const args = rest.join(" ");
		try {
			if (!subcommand || subcommand === "status") {
				const mission = args ? loadMission(ctx.cwd, args) : latestMission(ctx.cwd);
				if (!mission) ctx.ui.notify("No missions found.", "info");
				else {
					updateWidget(ctx, mission);
					ctx.ui.notify(summarizeMission(mission), "info");
				}
				return;
			}
			if (subcommand === "new") return await createMission(args, ctx, pi, setActivePlanning);
			if (subcommand === "approve") {
				const id = args || activePlanningId || latestMission(ctx.cwd)?.id;
				if (!id) {
					ctx.ui.notify("No mission to approve.", "warning");
					return;
				}
				const mission = loadMission(ctx.cwd, id);
				if (mission.milestones.length === 0) {
					ctx.ui.notify("Cannot approve: mission has no milestones/features. Ask the orchestrator to write the plan first.", "warning");
					return;
				}
				const dir = missionDir(ctx.cwd, id);
				if (!fs.existsSync(path.join(dir, "plan/validation-contract.json"))) {
					ctx.ui.notify("Cannot approve: missing plan/validation-contract.json.", "warning");
					return;
				}
				const ok = await ctx.ui.confirm("Approve mission plan?", `${mission.title}\n\nThis locks planning and enables /missions run ${id}.`);
				if (!ok) return;
				mission.status = "planned";
				saveMission(ctx.cwd, mission);
				appendEvent(dir, "mission_approved", {});
				if (activePlanningId === id) setActivePlanning(undefined);
				updateWidget(ctx, mission);
				ctx.ui.notify(`Mission approved. Run with /missions run ${id}`, "info");
				return;
			}
			if (subcommand === "run" || subcommand === "resume") return await runMission(args, ctx);
			if (subcommand === "list") {
				const missions = listMissions(ctx.cwd);
				ctx.ui.notify(
					missions.length ? missions.map((m) => `${m.id}  ${m.status}  ${m.title}`).join("\n") : "No missions found.",
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /missions new [goal] | /missions approve [id] | /missions run [id] | /missions status [id] | /missions list", "warning");
		} catch (error) {
			ctx.ui.notify(`missions error: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerCommand("missions", {
		description: "Plan and run long sequential missions (/missions new|run|status|list)",
		handler: handleMissions,
	});

	pi.registerCommand("mission", {
		description: "Alias for /missions",
		handler: handleMissions,
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "missions-active-planning") {
				activePlanningId = (entry.data as { id?: string } | undefined)?.id;
			}
		}
		const latest = latestMission(ctx.cwd);
		if (!activePlanningId && latest?.status === "planning") activePlanningId = latest.id;
		updateWidget(ctx, latest);
	});
}
