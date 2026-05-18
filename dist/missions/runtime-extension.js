import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendEvent, BASE_SKILLS, clearedMissionsFile, ensureDir, globalSettingsFile, isMissionRole, missionDir, missionRoot, nowIso, parentSessionMarker, readJson, writeJson, } from "./runtime-core.js";
import { DEFAULT_MILESTONE_VALIDATION_FAILURE_LIMIT, LEGACY_ACTIVE_PLANNING_ENTRY, MISSION_ROLES, ORCHESTRATOR_STATE_ENTRY, PLANNING_KICKOFF_ENTRY, } from "./runtime-types.js";
import { formatGlobalModels, normalizeRoleModels, readMissionGlobalSettings, setGlobalModel } from "./core/settings.js";
import { childSessionRecordForRun, nextChildAttemptNumber, parseRunOwnershipSessionId, parseTranscriptSessionIdentity, readChildSessionRegistry, readOrchestratorSessionRecord, upsertChildSessionRecord, writeOrchestratorSessionRecord, } from "./core/session-records.js";
import { computeRecoveryGatePlan } from "./recovery-gate.js";
import { loadMissionControlViewModel } from "./core/mission-control-view-model.js";
import { artifactValidationErrorSummary, validateMissionArtifact } from "./runtime-artifact-schemas.js";
import { ACTIVE_MISSION_CHILD_ABORTERS, ACTIVE_MISSION_RUNS, activeMissionRunKey, isMissionRunActive, tryCancelCurrentChild } from "./runner/active-runs.js";
import { acquireRunnerLock, hasMissionExecutionStarted, isPidAlive, lockHeartbeatExpired, readRunnerLock, releaseRunnerLock, RUNNER_HEARTBEAT_INTERVAL_MS, upsertRunnerLockHeartbeat } from "./runner/locks.js";
import { describeBlock, dispatchMissionBlockRecovery, persistMissionBlock } from "./runner/recovery.js";
import { chooseFooterMission, formatMissionStatusSummary, mark, missionFooterProgressBar, missionFooterStatusText, missionListTextFromMissions, nextSuggestedAction } from "./status/formatting.js";
import { openMissionControl } from "./ui/mission-control.js";
function sessionIdentity(ctx) {
    const sessionPath = ctx.sessionManager.getSessionFile() || "";
    if (!sessionPath.trim())
        return undefined;
    return {
        sessionId: path.basename(sessionPath, path.extname(sessionPath)) || `pid-${process.pid}`,
        sessionPath,
    };
}
function ensureOfficialOrchestratorSessionRecord(ctx, mission) {
    const identity = sessionIdentity(ctx);
    if (!identity)
        return undefined;
    const existing = readOrchestratorSessionRecord(ctx.cwd, mission.id);
    const shouldReuseExisting = existing?.active && fs.existsSync(existing.sessionPath);
    if (shouldReuseExisting)
        return existing;
    return writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
        sessionId: identity.sessionId,
        sessionPath: identity.sessionPath,
        createdAt: existing?.createdAt || nowIso(),
        active: isActiveMissionStatus(mission.status),
    });
}
function setActiveRunOwnership(mission, run) {
    const ownership = {
        schemaVersion: 1,
        kind: run.kind,
        validatorMode: run.validatorMode,
        itemId: run.itemId,
        runId: run.runId,
        parentPid: process.pid,
        parentSessionMarker: parentSessionMarker(),
        startedAt: run.startedAt ?? nowIso(),
        intent: "active",
    };
    mission.activeRun = ownership;
    return ownership;
}
function clearActiveRunOwnership(mission) {
    mission.activeRun = undefined;
}
function persistRunOwnershipArtifact(runDir, ownership) {
    writeJson(path.join(runDir, "run-ownership.json"), ownership);
}
function pauseRequestFile(cwd, missionId) {
    return path.join(missionDir(cwd, missionId), "pause-request.json");
}
function readMissionPauseRequest(cwd, missionId) {
    const file = pauseRequestFile(cwd, missionId);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const request = readJson(file);
        if (typeof request.requestedAt === "string" && request.requestedAt.trim())
            return { requestedAt: request.requestedAt, source: typeof request.source === "string" ? request.source : undefined };
    }
    catch {
        // Treat malformed pause markers as present so Mission Control does not accidentally resume past a user's stop request.
    }
    return { requestedAt: nowIso(), source: "malformed_pause_request" };
}
function hasMissionPauseRequest(cwd, missionId) {
    return Boolean(readMissionPauseRequest(cwd, missionId));
}
function clearMissionPauseRequest(cwd, missionId) {
    const file = pauseRequestFile(cwd, missionId);
    if (fs.existsSync(file))
        fs.unlinkSync(file);
}
function requestMissionPauseAfterCurrent(cwd, mission, source) {
    const dir = missionDir(cwd, mission.id);
    const requestedAt = nowIso();
    writeJson(pauseRequestFile(cwd, mission.id), { schemaVersion: 1, missionId: mission.id, requestedAt, source });
    const latest = loadMission(cwd, mission.id);
    if (latest.status === "paused") {
        latest.pauseRequestedAt = requestedAt;
        saveMission(cwd, latest);
    }
    appendEvent(dir, "mission_pause_requested", { missionId: mission.id, requestedAt, source });
    return { ok: true, text: `Pause-after-current requested for ${mission.id}. Current worker/validator will continue; no new unit will start.` };
}
function applyPauseAfterCurrentIfRequested(ctx, missionId, completedUnit) {
    const request = readMissionPauseRequest(ctx.cwd, missionId);
    if (!request)
        return false;
    const mission = loadMission(ctx.cwd, missionId);
    if (mission.status === "complete" || mission.status === "failed" || mission.status === "blocked")
        return false;
    transitionMissionPauseAfterCurrent(mission, request.requestedAt);
    saveMission(mission.cwd, mission);
    appendEvent(missionDir(ctx.cwd, missionId), "mission_paused_after_current", { missionId, requestedAt: request.requestedAt, completedUnit });
    updateWidget(ctx, mission);
    clearMissionRunStatus(ctx);
    ctx.ui.notify(`Mission paused after current unit: ${mission.title}`, "info");
    return true;
}
function markMissionExecutionStarted(mission) {
    if (mission.executionStartedAt)
        return mission;
    return { ...mission, executionStartedAt: nowIso() };
}
function hasRunnablePersistedPlan(cwd, mission) {
    try {
        const hasFeature = missionFeatureList(mission).length > 0;
        return hasFeature && fs.existsSync(path.join(missionDir(cwd, mission.id), "plan/validation-contract.json"));
    }
    catch {
        return false;
    }
}
function missionFeatureList(mission) {
    return missionMilestones(mission).flatMap((milestone) => milestone.features);
}
function missionMilestones(mission) {
    if (Array.isArray(mission.milestones) && mission.milestones.length > 0)
        return mission.milestones;
    return [];
}
function effectiveMilestoneValidationFailureLimit(mission, milestone) {
    const milestoneLimit = milestone.validationState?.failureLimit;
    if (typeof milestoneLimit === "number" && Number.isInteger(milestoneLimit) && milestoneLimit > 0)
        return milestoneLimit;
    const missionLimit = mission.validation?.failureLimit;
    if (typeof missionLimit === "number" && Number.isInteger(missionLimit) && missionLimit > 0)
        return missionLimit;
    return DEFAULT_MILESTONE_VALIDATION_FAILURE_LIMIT;
}
function milestoneValidationFailureCount(milestone) {
    const count = milestone.validationState?.failureCount;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}
function incrementMilestoneValidationFailureCount(milestone) {
    const next = milestoneValidationFailureCount(milestone) + 1;
    milestone.validationState = { ...milestone.validationState, failureCount: next };
    return next;
}
function setMilestoneValidationRunId(milestone, runId) {
    milestone.validationRunId = runId;
    milestone.validationState = { ...milestone.validationState, runId };
}
function mergeMissionFeatureState(primary, secondary) {
    const statusRank = { pending: 0, failed: 1, running: 2, skipped: 3, complete: 4 };
    const status = statusRank[secondary.status] > statusRank[primary.status] ? secondary.status : primary.status;
    return {
        ...primary,
        ...secondary,
        status,
        runId: secondary.runId ?? primary.runId,
        validationRunId: secondary.validationRunId ?? primary.validationRunId,
        userTestingRunId: secondary.userTestingRunId ?? primary.userTestingRunId,
        reviewerRunIds: secondary.reviewerRunIds ?? primary.reviewerRunIds,
        commit: secondary.commit ?? primary.commit,
        userTestingPending: secondary.userTestingPending ?? primary.userTestingPending,
        reviewerPending: secondary.reviewerPending ?? primary.reviewerPending,
    };
}
function syncMissionFeatureCopies(mission) {
    if (!Array.isArray(mission.milestones) || mission.milestones.length === 0)
        return mission;
    const mergedById = new Map();
    for (const feature of mission.features ?? [])
        mergedById.set(feature.id, feature);
    for (const milestone of mission.milestones) {
        for (const feature of milestone.features) {
            const existing = mergedById.get(feature.id);
            mergedById.set(feature.id, existing ? mergeMissionFeatureState(existing, feature) : feature);
        }
    }
    mission.milestones = mission.milestones.map((milestone) => {
        const features = milestone.features.map((feature) => mergedById.get(feature.id) ?? feature);
        const status = features.every((feature) => feature.status === "complete" || feature.status === "skipped")
            ? "complete"
            : features.some((feature) => feature.status === "running")
                ? "running"
                : features.some((feature) => feature.status === "failed")
                    ? "failed"
                    : "pending";
        return { ...milestone, status, features };
    });
    delete mission.features;
    return mission;
}
function normalizeMissionShape(mission) {
    return syncMissionFeatureCopies(mission);
}
function stripLegacyFeatureValidationState(feature) {
    const persisted = { ...feature };
    delete persisted.validationRunId;
    delete persisted.userTestingRunId;
    delete persisted.reviewerRunIds;
    delete persisted.userTesting;
    delete persisted.reviewers;
    delete persisted.userTestingPending;
    delete persisted.reviewerPending;
    return persisted;
}
function missionForPersistence(mission) {
    const persisted = normalizeMissionShape({ ...mission, milestones: mission.milestones?.map((milestone) => ({ ...milestone, features: milestone.features.map((feature) => ({ ...feature })) })) });
    if (Array.isArray(persisted.milestones) && persisted.milestones.length > 0) {
        delete persisted.features;
        persisted.milestones = persisted.milestones.map((milestone) => ({ ...milestone, features: milestone.features.map(stripLegacyFeatureValidationState) }));
    }
    return persisted;
}
function normalizeMissionForRuntime(cwd, mission) {
    const normalized = normalizeMissionShape(mission);
    if (normalized.status === "planning" && hasRunnablePersistedPlan(cwd, normalized))
        return { ...normalized, status: "planned" };
    return normalized;
}
function loadMission(cwd, id) {
    return normalizeMissionForRuntime(cwd, readJson(path.join(missionDir(cwd, id), "mission.json")));
}
function saveMission(cwd, mission) {
    normalizeMissionShape(mission);
    mission.updatedAt = nowIso();
    writeJson(path.join(missionDir(cwd, mission.id), "mission.json"), missionForPersistence(mission));
    const existingOrchestrator = readOrchestratorSessionRecord(cwd, mission.id);
    if (existingOrchestrator && existingOrchestrator.active !== isActiveMissionStatus(mission.status)) {
        writeOrchestratorSessionRecord(cwd, mission.id, {
            sessionId: existingOrchestrator.sessionId,
            sessionPath: existingOrchestrator.sessionPath,
            createdAt: existingOrchestrator.createdAt,
            active: isActiveMissionStatus(mission.status),
        });
    }
}
function listMissions(cwd) {
    const root = missionRoot(cwd);
    if (!fs.existsSync(root))
        return [];
    return fs
        .readdirSync(root)
        .map((name) => path.join(root, name, "mission.json"))
        .filter((file) => fs.existsSync(file))
        .map((file) => normalizeMissionForRuntime(cwd, readJson(file)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function isMissionForCwd(mission, cwd) {
    return path.resolve(mission.cwd) === path.resolve(cwd);
}
function latestMission(cwd) {
    const missions = listMissions(cwd);
    return missions.find((mission) => isMissionForCwd(mission, cwd)) ?? missions[0];
}
function latestVisibleMission(cwd) {
    const missions = listMissions(cwd).filter((mission) => mission.status !== "complete" && !isMissionCleared(cwd, mission.id));
    return missions.find((mission) => isMissionForCwd(mission, cwd)) ?? missions[0];
}
function isActiveMissionStatus(status) {
    return status === "planning" || status === "planned" || status === "running" || status === "paused" || status === "blocked";
}
function activeMissionFromState(cwd, state) {
    const ids = [state?.activeMissionId, state?.activePlanningMissionId, state?.activeRunningMissionId, state?.lastMissionId].filter((id) => Boolean(id));
    for (const id of ids) {
        try {
            const mission = loadMission(cwd, id);
            if (isActiveMissionStatus(mission.status))
                return mission;
        }
        catch {
            // Ignore stale session entries that point at missions no longer present in this checkout.
        }
    }
    const active = listMissions(cwd).filter((mission) => isActiveMissionStatus(mission.status) && !isMissionCleared(cwd, mission.id));
    return active.find((mission) => isMissionForCwd(mission, cwd)) ?? active[0];
}
function buildOrchestratorState(cwd, mission, overrides = {}) {
    const hasOverride = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
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
function latestOrchestratorStateFromSession(cwd, entries) {
    let state;
    let legacyPlanningId;
    for (const entry of entries) {
        if (entry.type !== "custom")
            continue;
        if (entry.customType === ORCHESTRATOR_STATE_ENTRY) {
            const data = entry.data;
            if (data?.schemaVersion === 1 && (!data.cwd || data.cwd === cwd))
                state = { ...data, schemaVersion: 1, cwd, updatedAt: data.updatedAt || nowIso() };
        }
        if (entry.customType === LEGACY_ACTIVE_PLANNING_ENTRY) {
            legacyPlanningId = entry.data?.id;
        }
    }
    if (!state && legacyPlanningId)
        return buildOrchestratorState(cwd, undefined, { activeMissionId: legacyPlanningId, activePlanningMissionId: legacyPlanningId, lastMissionId: legacyPlanningId });
    return state;
}
function lightweightMissionContext(cwd, state) {
    const mission = activeMissionFromState(cwd, state);
    if (!mission)
        return undefined;
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
    ].filter((line) => Boolean(line)).join("\n");
}
function runningMissionOrchestratorContext(cwd, mission) {
    return [
        "[RUNNING MISSION ORCHESTRATOR SESSION]",
        "This is the dedicated orchestrator chat for a running or active mission.",
        `Mission: ${mission.id} — ${mission.title} [${mission.status}]`,
        `Mission directory: ${missionDir(cwd, mission.id)}`,
        `Current feature: ${mission.currentFeatureId ?? "not set"}`,
        "",
        "Your role:",
        "- Coordinate, diagnose, redirect, pause/resume, and revise this mission.",
        "- Do not implement repository code directly unless the user explicitly asks for manual repair outside mission execution.",
        "- Use mission status/artifacts first when discussing active execution.",
        "- Prefer milestone-level recovery: failed milestone validation remains blocked for orchestrator diagnosis, plan/feature revision, and explicit resume rather than automatic retry or feature reset.",
        "",
        "Initial mission status:",
        summarizeMission(mission),
    ].join("\n");
}
function missionPlanningKickoffContext(cwd, goal) {
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
        "Use the mission-plan skill for mission planning. Do not write application code while planning. The mission-orchestrator skill is for event-driven runtime recovery after execution starts.",
        "First brainstorm with the user: ask clarifying questions, push back on scope, surface tradeoffs, and iterate in normal chat.",
        "Do not call mission_write_plan merely because /missions was invoked. Call mission_write_plan only when you judge the plan and validation contract are mature enough to persist, or when the user explicitly asks you to save the draft.",
        "After the user has reviewed the persisted plan, use mission_start_execution as the single explicit start/run confirmation gate before implementation begins.",
        "The user may ask unrelated questions at any time; answer those normally and return to mission planning only when relevant.",
    ].join("\n");
}
function readClearedMissions(cwd) {
    const file = clearedMissionsFile(cwd);
    if (!fs.existsSync(file))
        return { schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [] };
    const parsed = readJson(file);
    return {
        schemaVersion: 1,
        updatedAt: parsed.updatedAt || nowIso(),
        clearedMissionIds: Array.isArray(parsed.clearedMissionIds) ? [...new Set(parsed.clearedMissionIds.filter((id) => typeof id === "string"))] : [],
    };
}
function writeClearedMissions(cwd, state) {
    writeJson(clearedMissionsFile(cwd), { ...state, schemaVersion: 1, updatedAt: nowIso(), clearedMissionIds: [...new Set(state.clearedMissionIds)].sort() });
}
function resolveRoleModel(cwd, mission, role) {
    const missionModel = mission.models?.[role];
    if (missionModel && missionModel !== "default")
        return missionModel;
    return readMissionGlobalSettings(cwd).models[role];
}
function findMissionModelReference(modelReference, models) {
    const reference = modelReference.trim();
    if (!reference)
        return undefined;
    const slash = reference.indexOf("/");
    if (slash > 0) {
        const provider = reference.slice(0, slash);
        const modelId = reference.slice(slash + 1);
        const canonical = models.find((model) => model.provider === provider && model.id === modelId);
        if (canonical)
            return canonical;
    }
    const exactIdMatches = models.filter((model) => model.id === reference);
    if (exactIdMatches.length === 1)
        return exactIdMatches[0];
    const exactNameMatches = models.filter((model) => model.name === reference);
    if (exactNameMatches.length === 1)
        return exactNameMatches[0];
    return undefined;
}
function describeModel(model) {
    return `${model.provider}/${model.id}`;
}
async function applyGlobalOrchestratorModelDefault(ctx, pi) {
    const modelReference = readMissionGlobalSettings(ctx.cwd).models.orchestrator;
    if (!modelReference || modelReference === "default")
        return undefined;
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
function isMissionCleared(cwd, id) {
    return readClearedMissions(cwd).clearedMissionIds.includes(id);
}
function clearCompletedMissions(cwd) {
    const missions = listMissions(cwd);
    const completedIds = missions.filter((mission) => mission.status === "complete").map((mission) => mission.id);
    const state = readClearedMissions(cwd);
    const existing = new Set(state.clearedMissionIds);
    const clearedIds = completedIds.filter((id) => !existing.has(id));
    const alreadyClearedIds = completedIds.filter((id) => existing.has(id));
    if (clearedIds.length > 0) {
        writeClearedMissions(cwd, { ...state, clearedMissionIds: [...state.clearedMissionIds, ...clearedIds] });
        for (const id of clearedIds)
            appendEvent(missionDir(cwd, id), "mission_cleared", { clearedStateFile: clearedMissionsFile(cwd) });
    }
    const text = clearedIds.length > 0
        ? `Cleared ${clearedIds.length} completed mission${clearedIds.length === 1 ? "" : "s"}: ${clearedIds.join(", ")}. Artifacts were not deleted and statuses remain complete.`
        : completedIds.length > 0
            ? `No completed missions to clear; ${alreadyClearedIds.length} completed mission${alreadyClearedIds.length === 1 ? " is" : "s are"} already cleared.`
            : "No completed missions to clear.";
    return { clearedIds, alreadyClearedIds, completedIds, text };
}
function getPiInvocation(args) {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }
    const execName = path.basename(process.execPath).toLowerCase();
    if (/^(node|bun)(\.exe)?$/.test(execName))
        return { command: "pi", args };
    return { command: process.execPath, args };
}
function textFromMessage(msg) {
    if (msg.role !== "assistant")
        return "";
    return msg.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
async function runPiChild(options) {
    ensureDir(path.dirname(options.transcriptFile));
    const args = ["--mode", "json", "-p", "--no-session"];
    if (options.model && options.model !== "default")
        args.push("--model", options.model);
    for (const file of options.systemPromptFiles) {
        if (fs.existsSync(file))
            args.push("--append-system-prompt", file);
    }
    args.push(options.prompt);
    const result = { exitCode: 0, messages: [], stderr: "", finalText: "" };
    await new Promise((resolve) => {
        const invocation = getPiInvocation(args);
        const proc = spawn(invocation.command, invocation.args, {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
        let buffer = "";
        const transcript = fs.createWriteStream(options.transcriptFile, { flags: "a" });
        const processLine = (line) => {
            if (!line.trim())
                return;
            transcript.write(`${line}\n`);
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                return;
            }
            if (event.type === "message_end" && event.message) {
                const msg = event.message;
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
            for (const line of lines)
                processLine(line);
        });
        proc.stderr.on("data", (data) => {
            result.stderr += data.toString();
        });
        proc.on("close", (code) => {
            if (buffer.trim())
                processLine(buffer);
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
            if (options.signal.aborted)
                kill();
            else
                options.signal.addEventListener("abort", kill, { once: true });
        }
    });
    return result;
}
async function gitPorcelain(cwd) {
    const result = await new Promise((resolve) => {
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
async function gitHead(cwd) {
    return await new Promise((resolve) => {
        const proc = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : undefined));
        proc.on("error", () => resolve(undefined));
    });
}
function latestBlockFromArtifacts(mission) {
    if (mission.status === "complete")
        return undefined;
    if (mission.latestBlock)
        return mission.latestBlock;
    const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
    if (!fs.existsSync(logFile))
        return undefined;
    let latest;
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        try {
            const event = JSON.parse(line);
            if (event.type === "mission_block_recorded" && event.data?.schemaVersion === 1)
                latest = event.data;
        }
        catch {
            // Ignore malformed historical log entries; status rendering should be best-effort.
        }
    }
    return latest;
}
function compareRunIds(a, b) {
    const aPrefix = Number.parseInt(a, 10);
    const bPrefix = Number.parseInt(b, 10);
    if (Number.isFinite(aPrefix) && Number.isFinite(bPrefix) && aPrefix !== bPrefix)
        return aPrefix - bPrefix;
    return a.localeCompare(b);
}
function unfinishedValidatorRunContextsFromEvents(mission, recordedRunIds) {
    const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
    if (!fs.existsSync(logFile))
        return [];
    const starts = new Map();
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        try {
            const event = JSON.parse(line);
            const runId = typeof event.data?.runId === "string" ? event.data.runId : undefined;
            const milestoneId = typeof event.data?.milestoneId === "string" ? event.data.milestoneId : undefined;
            if (!runId || !milestoneId)
                continue;
            if (event.type === "validator_started")
                starts.set(runId, { milestoneId });
            if (event.type === "validator_finished")
                starts.delete(runId);
        }
        catch {
            // Ignore malformed historical log entries; status rendering should be best-effort.
        }
    }
    return [...starts.entries()]
        .filter(([runId]) => !recordedRunIds.has(runId))
        .map(([runId, started]) => {
        const milestone = missionMilestones(mission).find((m) => m.id === started.milestoneId);
        return {
            label: "Current validator run",
            runId,
            runDir: path.join(missionDir(mission.cwd, mission.id), "runs", runId),
            kind: "validator",
            validatorMode: "scrutiny",
            itemId: started.milestoneId,
            itemTitle: milestone?.title ?? started.milestoneId,
            status: "running",
        };
    });
}
function missionRunContexts(mission) {
    const contexts = [];
    const recordedRunIds = new Set();
    for (const milestone of missionMilestones(mission)) {
        for (const feature of milestone.features) {
            if (feature.runId) {
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
            if (feature.validationRunId) {
                recordedRunIds.add(feature.validationRunId);
                contexts.push({
                    label: `${feature.status === "running" ? "Current" : "Last"} validator run`,
                    runId: feature.validationRunId,
                    runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.validationRunId),
                    kind: "validator",
                    validatorMode: "scrutiny",
                    itemId: feature.id,
                    itemTitle: feature.title,
                    status: feature.status,
                });
            }
            if (feature.userTestingRunId) {
                recordedRunIds.add(feature.userTestingRunId);
                contexts.push({
                    label: `${feature.status === "running" ? "Current" : "Last"} user-testing run`,
                    runId: feature.userTestingRunId,
                    runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.userTestingRunId),
                    kind: "validator",
                    validatorMode: "user-testing",
                    itemId: feature.id,
                    itemTitle: feature.title,
                    status: feature.status,
                });
            }
        }
        if (milestone.validationRunId) {
            recordedRunIds.add(milestone.validationRunId);
            contexts.push({
                label: `${milestone.status === "running" ? "Current" : "Last"} validator run`,
                runId: milestone.validationRunId,
                runDir: path.join(missionDir(mission.cwd, mission.id), "runs", milestone.validationRunId),
                kind: "validator",
                validatorMode: "scrutiny",
                itemId: milestone.id,
                itemTitle: milestone.title,
                status: milestone.status,
            });
        }
    }
    contexts.push(...unfinishedValidatorRunContextsFromEvents(mission, recordedRunIds));
    return contexts.sort((a, b) => compareRunIds(a.runId, b.runId));
}
function currentOrLastRunContext(mission) {
    const contexts = missionRunContexts(mission);
    return contexts.filter((ctx) => ctx.status === "running").at(-1) ?? contexts.at(-1);
}
function runArtifactStatus(run) {
    const file = path.join(run.runDir, run.kind === "worker" ? "handoff.json" : run.validatorMode === "user-testing" ? "user-testing-report.json" : "validation-report.json");
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = readJson(file);
        return typeof parsed.status === "string" && parsed.status.trim() ? parsed.status.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
function synthesizeWorkerHandoffArtifacts(runDir, feature, result, commit) {
    const handoffFile = path.join(runDir, "handoff.json");
    const handoffMdFile = path.join(runDir, "handoff.md");
    const synthesized = {
        featureId: feature.id,
        status: result.exitCode === 0 ? "complete" : "blocked",
        commit: commit ?? "unknown",
        summary: "Worker exited without handoff artifacts; orchestrator synthesized this handoff from runner metadata so validation/retry flow can continue.",
        implemented: [],
        leftUndone: ["Original worker did not produce required handoff.json/handoff.md."],
        filesChanged: [],
        commandsRun: [],
        issuesDiscovered: [],
        procedureCompliance: {
            readMissionContext: false,
            checkedGitStatusBeforeWork: false,
            ranRequiredValidation: false,
            committedChanges: Boolean(commit),
            updatedHandoff: false,
        },
        risks: ["Original worker did not produce required handoff.json/handoff.md; inspect transcript.jsonl for details."],
        synthesizedByOrchestrator: true,
        exitCode: result.exitCode,
    };
    writeJson(handoffFile, synthesized);
    fs.writeFileSync(handoffMdFile, [
        `# ${feature.id} Handoff`,
        "",
        "## Status",
        String(synthesized.status),
        "",
        "## Summary",
        synthesized.summary,
        "",
        "## Commit",
        commit ?? "not recorded",
        "",
        "## Risks",
        `- ${synthesized.risks[0]}`,
        "",
        "## Follow-up",
        "Inspect this run's transcript.jsonl and stderr.txt. Treat this as lower-confidence than a worker-authored handoff.",
    ].join("\n"));
    return synthesized;
}
function ensureValidatorFailureReportArtifacts(runDir, milestone, result, report, schemaError) {
    const reportFile = path.join(runDir, "validation-report.json");
    const reportMdFile = path.join(runDir, "validation-report.md");
    const hasStructuredReport = report && typeof report === "object" && typeof report.status === "string";
    if (hasStructuredReport) {
        if (!fs.existsSync(reportMdFile)) {
            const status = String(report.status ?? "fail");
            const summary = typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : "Validator reported a non-pass result.";
            fs.writeFileSync(reportMdFile, `# Validation Report\n\n- Milestone: ${milestone.id} - ${milestone.title}\n- Status: ${status}\n\n## Summary\n${summary}\n`);
        }
        return report;
    }
    const finalText = result.finalText.trim();
    const synthesized = {
        milestoneId: milestone.id,
        status: "fail",
        summary: schemaError || finalText || "Validator exited without a parseable validation-report.json artifact.",
        commandsRun: [],
        assertions: [],
        defects: [
            {
                id: "SYNTH-VALIDATOR-ARTIFACT",
                severity: "critical",
                title: "Missing or invalid validator report artifact",
                description: schemaError || (finalText ? `Validator did not produce parseable JSON, but final response was: ${finalText.slice(0, 2000)}` : "The validator run did not produce a parseable validation-report.json file. See transcript.jsonl and stderr.txt for failure details."),
                reproduction: "Inspect validation-report.json, validation-report.md, transcript.jsonl, and stderr.txt in this run directory."
            }
        ],
        procedureFindings: [],
        recommendation: "fix",
        risks: ["Validation output was synthesized by the orchestrator due to missing/invalid validator artifacts."]
    };
    writeJson(reportFile, synthesized);
    if (!fs.existsSync(reportMdFile)) {
        fs.writeFileSync(reportMdFile, [
            "# Validation Report",
            "",
            `- Milestone: ${milestone.id} - ${milestone.title}`,
            `- Status: fail`,
            `- Validator exit code: ${result.exitCode}`,
            "",
            "## Summary",
            synthesized.summary,
            "",
            "## Follow-up",
            "Inspect transcript.jsonl and stderr.txt in this run directory for root cause details."
        ].join("\n"));
    }
    return synthesized;
}
function classifyMissionRunLifecycle(cwd, mission) {
    const run = currentOrLastRunContext(mission);
    const artifactStatus = run ? runArtifactStatus(run) : undefined;
    const block = latestBlockFromArtifacts(mission);
    if (block && run && block.runId === run.runId)
        return { state: "blocked", run, reason: "mission block artifact recorded" };
    if (mission.status === "blocked")
        return { state: "blocked", run, reason: "mission status is blocked" };
    if (mission.status === "complete")
        return { state: "completed", run, reason: "mission status is complete" };
    const lock = readRunnerLock(cwd, mission.id);
    if (lock?.status === "active" && !lockHeartbeatExpired(lock)) {
        const alive = isPidAlive(lock.ownerPid);
        if (alive !== false)
            return { state: "active", run, reason: `runner lock owned by pid ${lock.ownerPid} with recent heartbeat ${lock.heartbeatAt}` };
    }
    if (artifactStatus === "complete")
        return { state: "completed", run, reason: "terminal run artifact status is complete" };
    if (artifactStatus === "blocked" || artifactStatus === "failed")
        return { state: "blocked", run, reason: `terminal run artifact status is ${artifactStatus}` };
    if (!run)
        return { state: mission.status === "running" ? "interrupted" : "completed", reason: mission.status === "running" ? "mission marked running without recorded run context" : "no active run context" };
    const ownership = mission.activeRun;
    if (ownership && ownership.runId === run.runId && mission.status === "running") {
        if (isMissionRunActive(cwd, mission.id))
            return { state: "active", run, reason: "runtime has an active mission execution lock" };
        const alive = isPidAlive(ownership.parentPid);
        if (alive === true)
            return { state: "interrupted", run, reason: `owner pid ${ownership.parentPid} is alive but no in-process execution lock exists` };
        if (alive === undefined)
            return { state: "interrupted", run, reason: "owner liveness check unavailable and no in-process execution lock exists" };
        return { state: "interrupted", run, reason: `owner pid ${ownership.parentPid} is not alive and no terminal artifact was found` };
    }
    if (run.status === "running" || mission.status === "running")
        return { state: "interrupted", run, reason: "running status persisted without live ownership evidence" };
    return { state: "completed", run, reason: "latest run context is not running" };
}
function updateWidget(ctx, mission) {
    // Mission Control is now the rich mission visibility surface. Keep only the
    // compact footer/status indicator here and always clear the legacy mission
    // widget so stale rich mission UI cannot survive reload, clear, block, or
    // completion transitions.
    ctx.ui.setWidget("missions", undefined);
    // Clear first so stale footer text from an older active/cleared mission cannot
    // survive if anything below throws while reconciling disk artifacts.
    ctx.ui.setStatus("missions", undefined);
    const vm = loadMissionControlViewModel(ctx.cwd);
    const selected = chooseFooterMission(vm, mission && !isMissionCleared(mission.cwd, mission.id) ? mission.id : undefined);
    if (!selected)
        return;
    const runningCount = vm.sections.find((section) => section.id === "running")?.missions.filter((entry) => entry.id !== selected.id).length ?? 0;
    const blockedCount = vm.sections.find((section) => section.id === "blockedFailed")?.missions.filter((entry) => entry.id !== selected.id).length ?? 0;
    const parts = [
        `mission: ${missionFooterStatusText(selected)}`,
        `${selected.progress.completed}/${selected.progress.total} ${missionFooterProgressBar(selected.progress.completed, selected.progress.total)}`,
    ];
    if (runningCount > 0)
        parts.push(`+${runningCount} running`);
    if (blockedCount > 0)
        parts.push(`${blockedCount} blocked`);
    ctx.ui.setStatus("missions", truncateToWidth(parts.join(" · "), 120));
}
function clearMissionRunStatus(ctx) {
    // Child pi output is already captured in transcript/stderr artifacts. Do not
    // mirror it into a widget: widgets consume scrollback space and can push the
    // Mission Control component off screen while background workers are active.
    ctx.ui.setWidget("missions-run", undefined);
    ctx.ui.setStatus("missions-run", undefined);
}
function updateMissionRunStatus(ctx, _label, _text) {
    // The compact `missions` footer item is the only always-on mission status.
    // Child output already streams into transcript/stderr artifacts and is visible
    // through Mission Control detail. Mirroring it in the footer creates noisy,
    // stale duplicate status text during long-running missions.
    ctx.ui.setWidget("missions-run", undefined);
    ctx.ui.setStatus("missions-run", undefined);
}
function existingPaths(paths) {
    return paths.filter((file) => fs.existsSync(file));
}
function classifyWorkerBlock(result, handoff, dirty) {
    if (result.exitCode !== 0)
        return "child_exit_nonzero";
    if (!handoff)
        return "missing_handoff";
    if (dirty)
        return "dirty_worktree";
    return "worker_reported_blocked";
}
function classifyValidatorBlock(result, report) {
    if (result.exitCode !== 0)
        return "child_exit_nonzero";
    if (!report)
        return "missing_validation_report";
    return "validator_report_failed";
}
function summarizeMission(mission) {
    const features = missionFeatureList(mission);
    const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
    const run = currentOrLastRunContext(mission);
    const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
    const lifecycleEvaluation = evaluateMissionLifecycleTransition(mission, lifecycle);
    const block = latestBlockFromArtifacts(mission);
    return formatMissionStatusSummary({
        mission,
        featureCount: features.length,
        completedFeatureCount: done,
        milestones: missionMilestones(mission),
        run,
        lifecycle,
        lifecycleEvaluation,
        block,
        describeBlock,
    });
}
function boundedExcerpt(text, maxChars = 700) {
    const normalized = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
    if (normalized.length <= maxChars)
        return normalized || "(no objective text provided)";
    return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}
function normalizeValidationContractJson(validationContractJson) {
    if (Array.isArray(validationContractJson))
        return { assertions: validationContractJson };
    const maybeAssertions = validationContractJson?.assertions;
    return { assertions: Array.isArray(maybeAssertions) ? maybeAssertions : [] };
}
function validationSummary(validationContractJson) {
    const maybeAssertions = normalizeValidationContractJson(validationContractJson).assertions;
    if (maybeAssertions.length === 0)
        return "Validation: no assertions array found.";
    const categories = new Map();
    for (const assertion of maybeAssertions) {
        const category = typeof assertion?.category === "string" ? assertion.category : "uncategorized";
        categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    const categoryText = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `${category}: ${count}`).join(", ");
    return `Validation: ${maybeAssertions.length} assertion${maybeAssertions.length === 1 ? "" : "s"}${categoryText ? ` (${categoryText})` : ""}.`;
}
function planOutline(mission, maxFeatures = 32) {
    const features = missionFeatureList(mission);
    if (features.length === 0)
        return ["(no features provided)"];
    const lines = features.slice(0, maxFeatures).map((feature) => `${mark(feature.status)} ${feature.id}: ${feature.title}`);
    if (features.length > maxFeatures)
        lines.push(`… ${features.length - maxFeatures} more feature${features.length - maxFeatures === 1 ? "" : "s"}`);
    return lines;
}
function persistedPlanSummary(mission, dir, objectiveMd, validationContractJson, existingMission) {
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
        "Features:",
        ...planOutline(mission),
        "",
        validationSummary(validationContractJson),
    ].join("\n") + nextAction;
}
function missionListText(cwd) {
    return missionListTextFromMissions(listMissions(cwd), (missionId) => isMissionCleared(cwd, missionId));
}
function visibleMissions(cwd) {
    return listMissions(cwd).filter((mission) => !isMissionCleared(cwd, mission.id));
}
function resolveMission(cwd, id, state) {
    return id ? loadMission(cwd, id) : activeMissionFromState(cwd, state) ?? latestMission(cwd);
}
function clipLine(line, width) {
    // Leave a one-column guard for terminal/wcwidth disagreements around emoji and
    // ellipsis glyphs. Mission Control is embedded directly in the main TUI render;
    // a single over-wide custom line crashes the whole pi process.
    const limit = Math.max(1, width - 1);
    return truncateToWidth(line, limit);
}
function padLineToWidth(line, width) {
    const clipped = clipLine(line, width);
    return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
function exactClipLine(line, width) {
    return truncateToWidth(line, Math.max(1, width));
}
function exactPadLineToWidth(line, width) {
    const clipped = exactClipLine(line, width);
    return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
function missionFeatureCounts(mission) {
    const features = missionFeatureList(mission);
    const done = features.filter((f) => f.status === "complete" || f.status === "skipped").length;
    const running = features.filter((f) => f.status === "running").length;
    const failed = features.filter((f) => f.status === "failed").length;
    const pending = features.filter((f) => f.status === "pending").length;
    return { done, total: features.length, running, failed, pending };
}
function progressText(mission) {
    const counts = missionFeatureCounts(mission);
    return `${counts.done}/${counts.total}`;
}
function percentText(done, total) {
    return total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}
function progressBar(done, total, width) {
    const safeWidth = Math.max(8, width);
    const filled = total > 0 ? Math.round((done / total) * safeWidth) : 0;
    return `${"█".repeat(Math.max(0, Math.min(safeWidth, filled)))}${"░".repeat(Math.max(0, safeWidth - filled))}`;
}
function dividerLine(label, width) {
    const safeWidth = Math.max(20, width);
    const innerWidth = Math.max(4, safeWidth - 2);
    const title = ` ${label} `;
    const titleWidth = visibleWidth(title);
    const remaining = Math.max(0, innerWidth - titleWidth);
    const left = "─".repeat(Math.floor(remaining / 2));
    const right = "─".repeat(Math.ceil(remaining / 2));
    return exactClipLine(`┌${left}${title}${right}┐`, safeWidth);
}
function panelLines(title, body, width) {
    const safeWidth = Math.max(20, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const header = dividerLine(title, safeWidth);
    const clippedBody = body.length > 0 ? body.map((line) => exactClipLine(line, innerWidth)) : [exactClipLine("(no data)", innerWidth)];
    return [header, ...clippedBody.map((line) => exactClipLine(`│${exactPadLineToWidth(line, innerWidth)}│`, safeWidth)), exactClipLine(`└${"─".repeat(innerWidth)}┘`, safeWidth)];
}
function readTailText(file, maxBytes) {
    const stat = fs.statSync(file);
    const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes));
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(file, "r");
    try {
        fs.readSync(fd, buffer, 0, bytesToRead, start);
    }
    finally {
        fs.closeSync(fd);
    }
    let text = buffer.toString("utf8");
    if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return { text, truncated: start > 0 };
}
function readMissionEventWindow(mission, maxEvents = 8, maxBytes = 64 * 1024) {
    const logFile = path.join(missionDir(mission.cwd, mission.id), "event-log.jsonl");
    if (!fs.existsSync(logFile))
        return { events: [], parsedInTail: 0, malformedInTail: 0, truncated: false, maxEvents };
    const tail = readTailText(logFile, maxBytes);
    const events = [];
    let malformedInTail = 0;
    for (const line of tail.text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed.type === "string")
                events.push({ ts: typeof parsed.ts === "string" ? parsed.ts : undefined, type: parsed.type, data: parsed.data });
            else
                malformedInTail += 1;
        }
        catch {
            // Ignore malformed historical log entries; Mission Control is best-effort and must keep rendering.
            malformedInTail += 1;
        }
    }
    return { events: events.slice(-maxEvents), parsedInTail: events.length, malformedInTail, truncated: tail.truncated, maxEvents };
}
function relativeEventTime(ts, now = Date.now()) {
    if (!ts)
        return "time ?";
    const time = Date.parse(ts);
    if (!Number.isFinite(time))
        return "time ?";
    const diffSeconds = Math.max(0, Math.round((now - time) / 1000));
    if (diffSeconds < 60)
        return `${diffSeconds}s ago`;
    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60)
        return `${diffMinutes}m ago`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 48)
        return `${diffHours}h ago`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 14)
        return `${diffDays}d ago`;
    return ts.replace(/^\d{4}-/, "").replace(/T/, " ").replace(/\.\d{3}Z$/, "Z");
}
function eventIcon(event) {
    const data = event.data && typeof event.data === "object" ? event.data : undefined;
    const exitCode = typeof data?.exitCode === "number" ? data.exitCode : undefined;
    if (event.type.includes("block") || event.type.includes("failed") || event.type.includes("error") || (typeof exitCode === "number" && exitCode !== 0))
        return "✗";
    if (event.type.includes("finished") || event.type.includes("complete"))
        return "✓";
    if (event.type.includes("started"))
        return "▶";
    if (event.type.includes("plan") || event.type.includes("written"))
        return "◆";
    return "•";
}
function eventLabel(type) {
    const labels = {
        interactive_plan_written: "plan written",
        mission_execution_started: "execution started",
        worker_started: "worker started",
        worker_finished: "worker finished",
        worker_failed: "worker failed",
        validator_started: "validator started",
        validator_finished: "validator finished",
        mission_block_recorded: "block recorded",
        mission_pause_requested: "pause requested",
        mission_paused_after_current: "paused after current",
        mission_resume_requested: "resume requested",
        mission_auto_resume_after_plan_revision: "auto resume requested",
        mission_cleared: "mission cleared",
        mission_control_action_started: "control action started",
        mission_control_action_finished: "control action finished",
        mission_control_action_canceled: "control action canceled",
        mission_control_action_failed: "control action failed",
        handoff_parse_error: "handoff parse error",
        validation_parse_error: "validation parse error",
        user_testing_started: "user testing started",
        user_testing_finished: "user testing finished",
        user_testing_parse_error: "user testing parse error",
        mission_complete: "mission complete",
    };
    return labels[type] ?? type.replace(/_/g, " ");
}
function shortRunId(runId) {
    if (typeof runId !== "string" || !runId)
        return undefined;
    const parts = runId.split("-");
    return parts.length >= 3 ? `${parts[1]}-${parts.slice(2).join("-")}` : runId;
}
function eventDataSummary(event) {
    if (!event.data || typeof event.data !== "object")
        return "";
    const record = event.data;
    const pieces = [];
    const featureId = typeof record.featureId === "string" ? record.featureId : undefined;
    const milestoneId = typeof record.milestoneId === "string" ? record.milestoneId : undefined;
    const runId = shortRunId(record.runId);
    const status = typeof record.status === "string" ? record.status : undefined;
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const failedItemId = typeof record.failedItemId === "string" ? record.failedItemId : undefined;
    const reason = typeof record.reasonCategory === "string" ? record.reasonCategory.replace(/_/g, " ") : undefined;
    const actionId = typeof record.actionId === "string" ? record.actionId.replace(/-/g, " ") : undefined;
    const source = typeof record.source === "string" ? record.source.replace(/_/g, " ") : undefined;
    const completedUnit = typeof record.completedUnit === "string" ? record.completedUnit : undefined;
    const ok = typeof record.ok === "boolean" ? record.ok : undefined;
    const tool = typeof record.toolName === "string" ? record.toolName : typeof record.name === "string" ? record.name : undefined;
    const textSummary = [record.summary, record.text, record.message, record.error]
        .find((value) => typeof value === "string" && value.trim().length > 0);
    if (event.type === "mission_block_recorded") {
        if (kind || failedItemId)
            pieces.push([kind, failedItemId].filter(Boolean).join(" "));
        if (reason)
            pieces.push(reason);
    }
    else {
        if (featureId)
            pieces.push(featureId);
        else if (milestoneId)
            pieces.push(milestoneId);
        if (actionId)
            pieces.push(actionId);
        if (completedUnit)
            pieces.push(`after ${completedUnit}`);
        if (source)
            pieces.push(source);
        if (tool)
            pieces.push(`tool ${tool}`);
        if (status)
            pieces.push(status);
        if (typeof ok === "boolean")
            pieces.push(ok ? "ok" : "not ok");
        if (typeof exitCode === "number")
            pieces.push(`exit ${exitCode}`);
        if (textSummary)
            pieces.push(compactSnippetText(textSummary, 90));
    }
    if (runId)
        pieces.push(`run ${runId}`);
    return pieces.length ? ` — ${pieces.join(" · ")}` : "";
}
function formatMissionEventLine(event, now = Date.now()) {
    return `${relativeEventTime(event.ts, now).padStart(7)} ${eventIcon(event)} ${eventLabel(event.type)}${eventDataSummary(event)}`;
}
function missionActivityViewModel(mission, selectedIndexFromEnd = 0) {
    const window = readMissionEventWindow(mission);
    const prefix = window.truncated ? "Recent tail" : "Recent log";
    const hidden = Math.max(0, window.parsedInTail - window.events.length);
    const headline = `${prefix}: showing ${window.events.length}/${window.parsedInTail} parsed event${window.parsedInTail === 1 ? "" : "s"}${hidden ? ` (${hidden} older in tail)` : ""}${window.malformedInTail ? ` · skipped ${window.malformedInTail} malformed` : ""}`;
    if (window.events.length === 0)
        return { headline, rows: [], events: [], hidden };
    const now = Date.now();
    const selected = Math.max(0, Math.min(window.events.length - 1, selectedIndexFromEnd));
    const rows = window.events.map((event, index) => {
        const marker = index === window.events.length - 1 - selected ? "▸" : " ";
        return `${marker} ${formatMissionEventLine(event, now)}`;
    });
    return { headline, rows, events: window.events, hidden };
}
function runArtifactSummaryLines(run) {
    const jsonFile = path.join(run.runDir, run.kind === "worker" ? "handoff.json" : run.validatorMode === "user-testing" ? "user-testing-report.json" : "validation-report.json");
    const mdFile = path.join(run.runDir, run.kind === "worker" ? "handoff.md" : run.validatorMode === "user-testing" ? "user-testing-report.md" : "validation-report.md");
    const transcriptFile = path.join(run.runDir, "transcript.jsonl");
    const stderrFile = path.join(run.runDir, "stderr.txt");
    const childSession = childSessionRecordForRun(run);
    const lines = [
        `${path.basename(jsonFile)}: ${fs.existsSync(jsonFile) ? jsonFile : "not available"}`,
        `${path.basename(mdFile)}: ${fs.existsSync(mdFile) ? mdFile : "not available"}`,
    ];
    if (childSession) {
        lines.push(`Child session: ${childSession.role} ${childSession.featureId ?? childSession.milestoneId} attempt ${childSession.attempt} · ${childSession.status}`);
        if (childSession.sessionId)
            lines.push(`Child session id: ${childSession.sessionId}`);
        if (childSession.sessionPath)
            lines.push(`Child session path: ${childSession.sessionPath}`);
        lines.push(`Child transcript: ${childSession.transcriptPath}`);
    }
    if (fs.existsSync(transcriptFile))
        lines.push(`transcript: ${transcriptFile}`);
    if (fs.existsSync(stderrFile))
        lines.push(`stderr: ${stderrFile}`);
    if (fs.existsSync(jsonFile)) {
        try {
            const artifact = readJson(jsonFile);
            const validation = validateMissionArtifact(run.kind === "worker" ? "worker-handoff" : run.validatorMode === "user-testing" ? "user-testing-report" : "scrutiny-validation-report", artifact);
            const status = typeof artifact.status === "string" ? artifact.status : undefined;
            const commit = typeof artifact.commit === "string" ? artifact.commit : undefined;
            const summary = typeof artifact.summary === "string" ? artifact.summary : undefined;
            if (status || commit)
                lines.push(`Artifact status: ${[status, commit ? `commit ${commit}` : undefined].filter(Boolean).join(" · ")}`);
            if (summary)
                lines.push(`Artifact summary: ${summary}`);
            if (!validation.ok)
                lines.push(artifactValidationErrorSummary(run.kind === "worker" ? "worker-handoff" : run.validatorMode === "user-testing" ? "user-testing-report" : "scrutiny-validation-report", validation.issues));
        }
        catch {
            lines.push(`Artifact summary: ${jsonFile} could not be parsed`);
        }
    }
    return lines;
}
function missionSkillPath(mission, role) {
    return path.join(missionDir(mission.cwd, mission.id), "skills", role === "worker" ? "worker" : "validator-scrutiny", "SKILL.md");
}
function validationContractAssertions(mission) {
    const file = path.join(missionDir(mission.cwd, mission.id), "plan", "validation-contract.json");
    if (!fs.existsSync(file))
        return [];
    try {
        const parsed = readJson(file);
        return normalizeValidationContractJson(parsed).assertions.filter((value) => Boolean(value) && typeof value === "object");
    }
    catch {
        return [];
    }
}
function featureDependencyLines(mission, feature) {
    if (!feature.dependencies?.length)
        return ["Preconditions: no feature dependencies recorded"];
    const features = new Map(missionMilestones(mission).flatMap((milestone) => milestone.features.map((item) => [item.id, item])));
    return [`Dependencies: ${feature.dependencies.map((id) => {
            const dependency = features.get(id);
            return dependency ? `${id} ${mark(dependency.status)} ${dependency.status}` : `${id} ? unknown`;
        }).join(", ")}`];
}
function validatorPreconditionLines(milestone) {
    const incomplete = milestone.features.filter((feature) => feature.status !== "complete" && feature.status !== "skipped");
    if (incomplete.length === 0)
        return ["Preconditions: all milestone features complete/skipped"];
    return [`Preconditions: waiting on ${incomplete.map((feature) => `${feature.id} ${feature.status}`).join(", ")}`];
}
function verificationHintLines(mission, categories) {
    const hints = validationContractAssertions(mission)
        .filter((assertion) => assertion.category && categories.includes(assertion.category))
        .slice(0, 3)
        .map((assertion) => `Verify ${assertion.id ?? assertion.category}: ${assertion.verification ?? assertion.assertion ?? "see validation contract"}`);
    return hints.length ? hints : ["Verify: see plan/validation-contract.json"];
}
function currentWorkArtifactLines(run) {
    if (!run)
        return ["Artifacts: no run directory yet"];
    return [`Run id: ${run.runId}`, `Run dir: ${run.runDir}`, ...runArtifactSummaryLines(run)];
}
function featureRunContext(mission, feature) {
    if (!feature.runId)
        return undefined;
    return {
        label: `${feature.status === "running" ? "Current" : "Feature"} worker run`,
        runId: feature.runId,
        runDir: path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId),
        kind: "worker",
        itemId: feature.id,
        itemTitle: feature.title,
        status: feature.status,
    };
}
function milestoneValidationRunContext(mission, milestone) {
    if (!milestone.validationRunId)
        return undefined;
    return {
        label: `${milestone.status === "running" ? "Current" : "Milestone"} validator run`,
        runId: milestone.validationRunId,
        runDir: path.join(missionDir(mission.cwd, mission.id), "runs", milestone.validationRunId),
        kind: "validator",
        validatorMode: "scrutiny",
        itemId: milestone.id,
        itemTitle: milestone.title,
        status: milestone.status,
    };
}
function currentSelection(mission) {
    const currentMilestone = missionMilestones(mission).find((m) => m.id === mission.currentMilestoneId) ?? missionMilestones(mission).find((m) => m.status === "running") ?? missionMilestones(mission)[0];
    if (!currentMilestone)
        return { kind: "mission", mission };
    const currentFeature = currentMilestone.features.find((f) => f.id === mission.currentFeatureId) ?? currentMilestone.features.find((f) => f.status === "running");
    if (currentFeature)
        return { kind: "feature", mission, milestone: currentMilestone, feature: currentFeature };
    return { kind: "milestone", mission, milestone: currentMilestone };
}
function blockSelectionId(block) {
    return `block:${block.runId}:${block.failedItemId}`;
}
function missionControlSelectableItems(mission, block = latestBlockFromArtifacts(mission)) {
    const items = [{ kind: "mission", mission }];
    if (block)
        items.push({ kind: "block", mission, block });
    for (const milestone of missionMilestones(mission)) {
        items.push({ kind: "milestone", mission, milestone });
        for (const feature of milestone.features)
            items.push({ kind: "feature", mission, milestone, feature });
    }
    return items;
}
function selectionId(selection) {
    if (selection.kind === "block")
        return blockSelectionId(selection.block);
    if (selection.kind === "feature")
        return selection.feature.id;
    if (selection.kind === "milestone")
        return selection.milestone.id;
    return selection.mission.id;
}
function missionControlSelectionById(mission, selectedId, block = latestBlockFromArtifacts(mission)) {
    if (selectedId) {
        const match = missionControlSelectableItems(mission, block).find((item) => selectionId(item) === selectedId);
        if (match)
            return match;
    }
    return currentSelection(mission);
}
function moveMissionControlSelection(mission, selectedId, delta) {
    const items = missionControlSelectableItems(mission);
    if (items.length === 0)
        return mission.id;
    const fallbackId = selectionId(currentSelection(mission));
    const currentIndex = Math.max(0, items.findIndex((item) => selectionId(item) === (selectedId ?? fallbackId)));
    const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta));
    return selectionId(items[nextIndex]);
}
function missionControlHeader(mission, width) {
    const run = currentOrLastRunContext(mission);
    const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
    const counts = missionFeatureCounts(mission);
    const barWidth = Math.max(8, Math.min(28, width - 44));
    const runText = run ? `${run.label} ${run.runId} (${run.kind} ${run.itemId})` : "no active run";
    const statusStrip = ` STATUS ${mission.status.toUpperCase()} · lifecycle ${lifecycle.state} · updated ${mission.updatedAt} `;
    const titleStrip = ` MISSION CONTROL · ${mission.title} (${mission.id}) `;
    const progressStrip = ` PROGRESS ${progressText(mission)} ${percentText(counts.done, counts.total)} · ${counts.running} running · ${counts.pending} pending · ${counts.failed} failed `;
    const line = (content) => {
        const innerWidth = Math.max(1, width - 2);
        return exactClipLine(`│${exactPadLineToWidth(content, innerWidth)}│`, width);
    };
    return [
        exactClipLine(`┌${"═".repeat(Math.max(1, width - 2))}┐`, width),
        line(titleStrip),
        line(statusStrip),
        line(`${progressStrip}[${progressBar(counts.done, counts.total, barWidth)}]`),
        line(` RUN ${runText} `),
        exactClipLine(`└${"═".repeat(Math.max(1, width - 2))}┘`, width),
    ];
}
function missionControlPlaneLines(mission) {
    const lock = readRunnerLock(mission.cwd, mission.id);
    const orchestrator = readOrchestratorSessionRecord(mission.cwd, mission.id);
    const now = Date.now();
    const lockLine = (() => {
        if (!lock)
            return "Runner lock: none";
        const heartbeat = relativeEventTime(lock.heartbeatAt, now);
        const owner = `pid ${lock.ownerPid} (${lock.ownerSessionMarker})`;
        const lockState = lock.status === "active" && !lockHeartbeatExpired(lock) ? "active" : lock.status;
        return `Runner lock: ${lockState} · ${owner} · heartbeat ${heartbeat}`;
    })();
    const currentFeatureId = mission.currentFeatureId;
    const currentMilestoneId = mission.currentMilestoneId;
    const registry = readChildSessionRegistry(mission.cwd, mission.id);
    const workerAttempts = currentFeatureId ? registry.records.filter((record) => record.role === "worker" && record.featureId === currentFeatureId).length : 0;
    const scrutinyAttempts = currentMilestoneId ? registry.records.filter((record) => record.role === "validator" && record.validatorMode !== "user-testing" && record.milestoneId === currentMilestoneId).length : 0;
    const userTestingAttempts = currentMilestoneId ? registry.records.filter((record) => record.role === "validator" && record.validatorMode === "user-testing" && record.milestoneId === currentMilestoneId).length : 0;
    return [
        lockLine,
        `Current feature worker attempt: ${currentFeatureId ? `${currentFeatureId} #${Math.max(1, workerAttempts)}` : "none"}`,
        `Current milestone scrutiny attempt: ${currentMilestoneId ? `${currentMilestoneId} #${Math.max(0, scrutinyAttempts)}` : "none"}`,
        `Current milestone user-testing attempt: ${currentMilestoneId ? `${currentMilestoneId} #${Math.max(0, userTestingAttempts)}` : "none"}`,
        `Official orchestrator session: ${orchestrator?.sessionPath ? orchestrator.sessionPath : "not recorded"}`,
        "Controls route via deterministic runner command API (p/s/x).",
    ];
}
function missionTreeLines(mission, selection, block) {
    const selectedId = selectionId(selection);
    const lines = ["Mission tree", `${selectedId === mission.id ? ">" : " "} ${mark(mission.status)} ${mission.id}`];
    if (block)
        lines.push(`${selectedId === blockSelectionId(block) ? ">" : " "} ! Block ${block.reasonCategory} on ${block.failedItemId}`);
    for (const milestone of missionMilestones(mission)) {
        lines.push(`${selectedId === milestone.id ? ">" : " "} ${mark(milestone.status)} ${milestone.id} ${milestone.title}`);
        for (const feature of milestone.features)
            lines.push(`${selectedId === feature.id ? ">" : " "}   ${mark(feature.status)} ${feature.id} ${feature.title}`);
    }
    return lines;
}
function blockInspectionLines(block) {
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
        block.kind === "worker" ? "1. Read handoff.json and handoff.md if present." : block.validatorMode === "user-testing" ? "1. Read user-testing-report.json and user-testing-report.md if present." : "1. Read validation-report.json and validation-report.md if present.",
        "2. Inspect transcript.jsonl and stderr.txt in the run directory if artifacts are missing or incomplete.",
        "3. Decide whether to revise the mission plan, fix the implementation, or resume execution.",
    ];
}
function missionDetailsLines(selection, run, block) {
    const mission = selection.mission;
    const lines = ["Details"];
    if (selection.kind === "mission") {
        lines.push(`Mission: ${mission.title}`, `ID: ${mission.id}`, `Status: ${mission.status}`, `Created: ${mission.createdAt}`, `Updated: ${mission.updatedAt}`);
    }
    else if (selection.kind === "block") {
        lines.push(...blockInspectionLines(selection.block));
    }
    else if (selection.kind === "milestone") {
        lines.push(`Milestone: ${selection.milestone.id} — ${selection.milestone.title}`, `Status: ${selection.milestone.status}`);
        if (selection.milestone.objective)
            lines.push(`Objective: ${selection.milestone.objective}`);
        if (selection.milestone.validation)
            lines.push(`Validation: ${selection.milestone.validation}`);
        if (selection.milestone.validationRunId)
            lines.push(`Validation run: ${selection.milestone.validationRunId}`);
    }
    else {
        lines.push(`Feature: ${selection.feature.id} — ${selection.feature.title}`, `Status: ${selection.feature.status}`);
        if (selection.feature.dependencies?.length)
            lines.push(`Dependencies: ${selection.feature.dependencies.join(", ")}`);
        if (selection.feature.runId)
            lines.push(`Run: ${selection.feature.runId}`);
        if (selection.feature.validationRunId)
            lines.push(`Validation run: ${selection.feature.validationRunId}`);
        if (selection.feature.userTestingRunId)
            lines.push(`User-testing run: ${selection.feature.userTestingRunId}`);
        lines.push(`Legacy feature user-testing flag: ${isFeatureUserTestingRequired(selection.feature) ? "yes" : "no"} (normal mission validation runs at milestone boundaries)`);
        if (selection.feature.commit)
            lines.push(`Commit: ${selection.feature.commit}`);
        lines.push(`Description: ${selection.feature.description}`);
    }
    if (run)
        lines.push("", "Run context", `${run.label}: ${run.runId}`, `Item: ${run.kind} ${run.itemId} — ${run.itemTitle}`, `Artifacts: ${run.runDir}`, ...runArtifactSummaryLines(run));
    if (block && selection.kind !== "block")
        lines.push("", "Block context", ...blockInspectionLines(block));
    return lines;
}
function progressLogLines(mission, selectedIndexFromEnd = 0) {
    const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
    const model = missionActivityViewModel(mission, selectedIndexFromEnd);
    if (model.events.length === 0) {
        const base = model.headline.includes("malformed") ? model.headline : "(no events recorded)";
        return [`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`, base];
    }
    return [`Run lifecycle: ${lifecycle.state}${lifecycle.reason ? ` (${lifecycle.reason})` : ""}`, model.headline, ...model.rows];
}
function conciseArtifactSummary(run) {
    if (!run)
        return "Artifacts: none yet";
    const summary = runArtifactSummaryLines(run).find((line) => line.startsWith("Artifact status:") || line.startsWith("Artifact summary:"));
    return summary ? `Artifacts: ${summary.replace(/^Artifact (status|summary):\s*/, "")}` : `Artifacts: run ${run.runId} recorded`;
}
function currentItemLines(selection, run, block, activityEvent) {
    const lifecycle = classifyMissionRunLifecycle(selection.mission.cwd, selection.mission);
    const nextAction = `Next action: ${nextSuggestedAction(selection.mission, lifecycle, run, block)}`;
    if (activityEvent) {
        return [
            `Activity event: ${eventLabel(activityEvent.type)}`,
            `When: ${relativeEventTime(activityEvent.ts)}${activityEvent.ts ? ` (${activityEvent.ts})` : ""}`,
            `Severity: ${eventIcon(activityEvent)}`,
            `Summary: ${eventLabel(activityEvent.type)}${eventDataSummary(activityEvent)}`,
            ...(activityEvent.data !== undefined ? ["Data:", compactSnippetText(JSON.stringify(activityEvent.data), 320)] : ["Data: none"]),
        ];
    }
    if (selection.kind === "mission") {
        const counts = missionFeatureCounts(selection.mission);
        return [
            `${mark(selection.mission.status)} Mission ${selection.mission.id}`,
            `Status: ${selection.mission.status} · lifecycle ${lifecycle.state}`,
            `Progress: ${progressText(selection.mission)} ${percentText(counts.done, counts.total)}`,
            `Current feature: ${selection.mission.currentFeatureId ?? "not set"}`,
            nextAction,
            conciseArtifactSummary(run),
        ];
    }
    if (selection.kind === "block")
        return blockInspectionLines(selection.block);
    if (selection.kind === "milestone") {
        const done = selection.milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
        const validatorRun = run?.kind === "validator" && run.itemId === selection.milestone.id ? run : milestoneValidationRunContext(selection.mission, selection.milestone);
        return [
            `${mark(selection.milestone.status)} Milestone ${selection.milestone.id}`,
            `Status: ${selection.milestone.status} · features ${done}/${selection.milestone.features.length}`,
            ...(selection.milestone.validationRunId ? [`Attempts: validator run ${selection.milestone.validationRunId}`] : ["Attempts: validator not started"]),
            ...(selection.milestone.validation ? [`Expected: ${selection.milestone.validation}`] : []),
            nextAction,
            conciseArtifactSummary(validatorRun),
        ];
    }
    const featureRun = run?.kind === "worker" && run.itemId === selection.feature.id ? run : featureRunContext(selection.mission, selection.feature);
    const registry = readChildSessionRegistry(selection.mission.cwd, selection.mission.id);
    const workerAttempts = registry.records.filter((record) => record.role === "worker" && record.featureId === selection.feature.id).length;
    const validatorAttempts = registry.records.filter((record) => record.role === "validator" && record.featureId === selection.feature.id).length;
    const userTestingAttempts = registry.records.filter((record) => record.role === "validator" && record.validatorMode === "user-testing" && record.featureId === selection.feature.id).length;
    const lines = [
        `${mark(selection.feature.status)} Feature ${selection.feature.id}`,
        `Status: ${selection.feature.status}`,
        `Attempts: worker ${workerAttempts} · validator ${validatorAttempts} · user-testing ${userTestingAttempts}`,
        ...(selection.feature.commit ? [`Commit: ${selection.feature.commit}`] : ["Commit: not recorded"]),
        conciseArtifactSummary(featureRun),
        nextAction,
        ...(selection.feature.description ? [`Summary: ${selection.feature.description}`] : []),
    ];
    if (block)
        lines.push(`Block: ${block.reasonCategory} on ${block.failedItemId}`);
    return lines;
}
function groupedFeatureLines(mission, selection, block) {
    const selectedId = selectionId(selection);
    const row = (id, status, label, indent = "") => {
        const selected = selectedId === id;
        return `${selected ? "▸" : " "} ${indent}${mark(status)} ${label}${selected ? " ◂" : ""}`;
    };
    const lines = [row(mission.id, mission.status, mission.id)];
    if (block)
        lines.push(`${selectedId === blockSelectionId(block) ? "▸" : " "} ! Block ${block.reasonCategory} on ${block.failedItemId}${selectedId === blockSelectionId(block) ? " ◂" : ""}`);
    for (const milestone of missionMilestones(mission)) {
        const done = milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
        lines.push(row(milestone.id, milestone.status, `${milestone.id} ${milestone.title} (${done}/${milestone.features.length})`));
        for (const feature of milestone.features)
            lines.push(row(feature.id, feature.status, `${feature.id} ${feature.title}`, "  "));
    }
    return lines;
}
const CHILD_TRANSCRIPT_TAIL_BYTES = 16 * 1024;
const CHILD_STDERR_TAIL_BYTES = 8 * 1024;
const CHILD_OUTPUT_MAX_TRANSCRIPT_LINES = 8;
const CHILD_OUTPUT_MAX_STDERR_LINES = 4;
const CHILD_OUTPUT_MAX_PANEL_LINES = 14;
function safeReadTailText(file, maxBytes) {
    if (!fs.existsSync(file))
        return { text: "", truncated: false, missing: true };
    try {
        return { ...readTailText(file, maxBytes), missing: false };
    }
    catch (error) {
        return { text: "", truncated: false, missing: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function compactSnippetText(value, maxChars = 220) {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}
function contentPartSnippet(part) {
    if (!part || typeof part !== "object")
        return undefined;
    const record = part;
    const type = typeof record.type === "string" ? record.type : "content";
    if (typeof record.text === "string")
        return compactSnippetText(record.text);
    if (typeof record.message === "string")
        return compactSnippetText(record.message);
    if (typeof record.name === "string" && (type === "tool_use" || type === "tool_call"))
        return `tool ${record.name}`;
    if (type === "tool_result" || type === "tool_output") {
        if (typeof record.content === "string")
            return `tool result: ${compactSnippetText(record.content)}`;
        return "tool result";
    }
    if (typeof record.content === "string")
        return compactSnippetText(record.content);
    return undefined;
}
function messageSnippet(message) {
    if (!message || typeof message !== "object")
        return undefined;
    const record = message;
    if (typeof record.content === "string")
        return compactSnippetText(record.content);
    if (Array.isArray(record.content)) {
        const snippets = record.content.map(contentPartSnippet).filter((snippet) => Boolean(snippet));
        if (snippets.length > 0)
            return snippets.join(" | ");
    }
    return undefined;
}
function transcriptEventSnippet(event) {
    const type = typeof event.type === "string" ? event.type : "event";
    const directText = [event.text, event.message, event.output, event.stdout].find((value) => typeof value === "string" && value.trim().length > 0);
    if (directText)
        return `${type}: ${compactSnippetText(directText)}`;
    const nestedMessage = messageSnippet(event.message);
    if (nestedMessage)
        return `${type}: ${nestedMessage}`;
    const delta = event.delta && typeof event.delta === "object" ? event.delta : undefined;
    if (typeof delta?.text === "string" && delta.text.trim())
        return `${type}: ${compactSnippetText(delta.text)}`;
    const contentDelta = event.content_delta && typeof event.content_delta === "object" ? event.content_delta : undefined;
    if (typeof contentDelta?.text === "string" && contentDelta.text.trim())
        return `${type}: ${compactSnippetText(contentDelta.text)}`;
    if (typeof event.name === "string" && (type.includes("tool") || event.tool_use_id))
        return `${type}: tool ${event.name}`;
    return undefined;
}
function transcriptStreamLine(event, fallback) {
    const type = typeof event.type === "string" ? event.type : "event";
    const timestamp = typeof event.message?.timestamp === "number" ? new Date(event.message.timestamp).toISOString().slice(11, 19) : "";
    const prefix = timestamp ? `${timestamp} ${type}` : type;
    const text = transcriptEventSnippet(event) ?? fallback;
    return `${prefix}: ${text.replace(/^${type}: /, "")}`;
}
function transcriptTailLines(file) {
    const tail = safeReadTailText(file, CHILD_TRANSCRIPT_TAIL_BYTES);
    if (tail.missing)
        return ["transcript.jsonl: not available yet"];
    if (tail.error)
        return [`transcript.jsonl: could not read tail (${tail.error})`];
    const stream = [];
    let malformed = 0;
    for (const rawLine of tail.text.split("\n")) {
        const line = rawLine.trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object")
                stream.push(transcriptStreamLine(parsed, line));
            else
                stream.push(`raw: ${line}`);
        }
        catch {
            malformed += 1;
            stream.push(`raw: ${line}`);
        }
    }
    const prefix = tail.truncated ? "transcript stream tail" : "transcript stream";
    const visible = stream.slice(-CHILD_OUTPUT_MAX_TRANSCRIPT_LINES);
    const hidden = Math.max(0, stream.length - visible.length);
    return [
        `${prefix}: ${stream.length} line${stream.length === 1 ? "" : "s"}${hidden ? ` · showing last ${visible.length}` : ""}${malformed ? ` · ${malformed} raw/malformed` : ""}`,
        ...visible,
    ];
}
function stderrTailLines(file) {
    const tail = safeReadTailText(file, CHILD_STDERR_TAIL_BYTES);
    if (tail.missing)
        return [];
    if (tail.error)
        return [`stderr.txt: could not read tail (${tail.error})`];
    const stderrLines = tail.text.split("\n").map((line) => compactSnippetText(line)).filter(Boolean).slice(-CHILD_OUTPUT_MAX_STDERR_LINES);
    if (stderrLines.length === 0)
        return [];
    return [`${tail.truncated ? "stderr tail" : "stderr"}:`, ...stderrLines.map((line) => `stderr: ${line}`)];
}
function childOutputSummaryLines(transcriptFile, stderrFile) {
    return [...transcriptTailLines(transcriptFile), ...stderrTailLines(stderrFile)];
}
function childOutputRawLines(transcriptFile) {
    const tail = safeReadTailText(transcriptFile, CHILD_TRANSCRIPT_TAIL_BYTES);
    if (tail.missing)
        return ["transcript.jsonl: not available yet"];
    if (tail.error)
        return [`transcript.jsonl: could not read tail (${tail.error})`];
    const rawLines = tail.text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-CHILD_OUTPUT_MAX_TRANSCRIPT_LINES);
    return [`${tail.truncated ? "transcript raw tail" : "transcript raw"}: showing ${rawLines.length} line${rawLines.length === 1 ? "" : "s"}`, ...rawLines.map((line) => `json: ${compactSnippetText(line, 260)}`)];
}
function childOutputLines(run, mode) {
    if (!run) {
        return [
            "Live stream: no active child run.",
            "Waiting for transcript.jsonl or stderr.txt artifacts.",
        ];
    }
    const transcriptFile = path.join(run.runDir, "transcript.jsonl");
    const stderrFile = path.join(run.runDir, "stderr.txt");
    const modeLabel = mode === "summary" ? "summary" : mode === "raw" ? "raw transcript" : "stderr";
    const modeLines = mode === "summary"
        ? childOutputSummaryLines(transcriptFile, stderrFile)
        : mode === "raw"
            ? childOutputRawLines(transcriptFile)
            : (() => {
                const stderr = stderrTailLines(stderrFile);
                return stderr.length > 0 ? stderr : ["stderr.txt: no output yet"];
            })();
    const lines = [
        `Live stream: ${run.label} ${run.kind === "worker" ? "worker" : run.kind}`,
        `Run: ${run.runId}`,
        `Item: ${run.kind} ${run.itemId} — ${run.itemTitle}`,
        `Artifacts: ${run.runDir}`,
        `View mode: ${modeLabel} (o to toggle)`,
        "",
        ...modeLines,
    ];
    return limitLines(lines, CHILD_OUTPUT_MAX_PANEL_LINES, 120);
}
function missionControlLayoutMode(width) {
    if (width >= 120)
        return "wide";
    if (width >= 90)
        return "medium";
    if (width >= 62)
        return "narrow";
    return "compact";
}
function limitLines(lines, maxLines, width) {
    if (lines.length <= maxLines)
        return lines.map((line) => exactClipLine(line, width));
    const hidden = lines.length - maxLines + 1;
    return [...lines.slice(0, Math.max(0, maxLines - 1)), `… ${hidden} more line${hidden === 1 ? "" : "s"}`].map((line) => exactClipLine(line, width));
}
function scrollWindow(lines, offset, maxBodyLines) {
    const maxOffset = Math.max(0, lines.length - maxBodyLines);
    const clampedOffset = Math.max(0, Math.min(offset, maxOffset));
    const body = lines.slice(clampedOffset, clampedOffset + maxBodyLines);
    return { body, maxOffset, clampedOffset };
}
function limitedPanelLines(title, body, width, maxPanelLines, offset = 0) {
    const maxBodyLines = Math.max(1, maxPanelLines - 2);
    const windowed = scrollWindow(body, offset, maxBodyLines);
    const scrollTitle = windowed.maxOffset > 0 ? `${title} ${windowed.clampedOffset + 1}/${windowed.maxOffset + 1}` : title;
    const suffix = windowed.maxOffset > 0
        ? [`… ${windowed.clampedOffset + 1}-${Math.min(body.length, windowed.clampedOffset + maxBodyLines)} / ${body.length}`]
        : [];
    return {
        lines: panelLines(scrollTitle, [...windowed.body, ...suffix], width),
        maxOffset: windowed.maxOffset,
        clampedOffset: windowed.clampedOffset,
    };
}
function compactMissionControlHeader(mission, width) {
    const counts = missionFeatureCounts(mission);
    const run = currentOrLastRunContext(mission);
    const lifecycle = classifyMissionRunLifecycle(mission.cwd, mission);
    const current = mission.currentFeatureId ?? mission.currentMilestoneId ?? "mission";
    return [
        clipLine(`MISSION ${mission.status}/${lifecycle.state} · ${progressText(mission)} ${percentText(counts.done, counts.total)}`, width),
        clipLine(`Current: ${current}${run ? ` · ${run.kind} ${run.runId}` : ""}`, width),
    ];
}
function compactGroupedFeatureLines(mission, selection, block) {
    const selectedId = selectionId(selection);
    const row = (id, status, label) => `${selectedId === id ? "▸" : " "} ${mark(status)} ${label}${selectedId === id ? " ◂" : ""}`;
    const lines = [];
    if (block)
        lines.push(`${selectedId === blockSelectionId(block) ? "▸" : " "} ! ${block.failedItemId}: ${block.reasonCategory}${selectedId === blockSelectionId(block) ? " ◂" : ""}`);
    for (const milestone of missionMilestones(mission)) {
        const done = milestone.features.filter((f) => f.status === "complete" || f.status === "skipped").length;
        lines.push(row(milestone.id, milestone.status, `${milestone.id} (${done}/${milestone.features.length})`));
        for (const feature of milestone.features)
            lines.push(row(feature.id, feature.status, `${feature.id} ${feature.title}`));
    }
    return lines;
}
function hasSessionSwitchControls(ctx) {
    return typeof ctx.newSession === "function" && typeof ctx.switchSession === "function";
}
async function openOrSwitchMissionOrchestratorSession(ctx, mission) {
    const existing = readOrchestratorSessionRecord(ctx.cwd, mission.id);
    const content = runningMissionOrchestratorContext(ctx.cwd, mission);
    if (existing?.sessionPath && fs.existsSync(existing.sessionPath)) {
        if (!existing.active) {
            writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
                sessionId: existing.sessionId,
                sessionPath: existing.sessionPath,
                createdAt: existing.createdAt,
                active: true,
            });
        }
        await ctx.switchSession(existing.sessionPath, {
            withSession: async (nextCtx) => {
                await nextCtx.sendMessage({ customType: "missions-running-orchestrator", display: true, content, details: { missionId: mission.id, missionDir: missionDir(ctx.cwd, mission.id), reusedSession: true } }, { deliverAs: "followUp" });
            },
        });
        return;
    }
    let createdSessionPath = "";
    await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sessionManager) => {
            createdSessionPath = sessionManager.getSessionFile() || "";
            sessionManager.appendSessionInfo(`Mission orchestrator: ${mission.title}`);
            sessionManager.appendCustomEntry(ORCHESTRATOR_STATE_ENTRY, buildOrchestratorState(ctx.cwd, mission, { activeMissionId: mission.id, activePlanningMissionId: undefined, activeRunningMissionId: mission.id }));
            writeOrchestratorSessionRecord(ctx.cwd, mission.id, {
                sessionId: createdSessionPath ? path.basename(createdSessionPath, path.extname(createdSessionPath)) : `pid-${process.pid}`,
                sessionPath: createdSessionPath || ctx.sessionManager.getSessionFile() || "",
                createdAt: nowIso(),
                active: true,
            });
        },
        withSession: async (nextCtx) => {
            await nextCtx.sendMessage({ customType: "missions-running-orchestrator", display: true, content, details: { missionId: mission.id, missionDir: missionDir(ctx.cwd, mission.id), sessionPath: createdSessionPath } }, { triggerTurn: true, deliverAs: "followUp" });
        },
    });
}
async function startMissionOrchestrator(args, ctx, pi) {
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
function persistedPlanStatus(incomingStatus, existingMission) {
    const existingIsStartedOrTerminal = existingMission && existingMission.status !== "planning" && existingMission.status !== "planned";
    if (!existingIsStartedOrTerminal)
        return "planned";
    if (!incomingStatus || incomingStatus === "planning" || incomingStatus === "planned") {
        if (existingMission.status === "complete" || existingMission.status === "failed")
            return "planned";
        return existingMission.status;
    }
    return incomingStatus;
}
function createMissionId() {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const rand = Math.random().toString(36).slice(2, 8);
    return `mission-${ts}-${rand}`;
}
function createPlanningMission(cwd, requestedId) {
    const id = requestedId || createMissionId();
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
function featureStatusById(mission) {
    const statuses = new Map();
    for (const milestone of missionMilestones(mission)) {
        for (const feature of milestone.features)
            statuses.set(feature.id, feature.status);
    }
    return statuses;
}
function areFeatureDependenciesSatisfied(feature, statuses) {
    return (feature.dependencies ?? []).every((dependencyId) => {
        const dependencyStatus = statuses.get(dependencyId);
        return dependencyStatus === "complete" || dependencyStatus === "skipped";
    });
}
function milestoneForFeature(mission, featureId) {
    return missionMilestones(mission).find((milestone) => milestone.features.some((feature) => feature.id === featureId));
}
function findNextFeature(mission) {
    const statuses = featureStatusById(mission);
    for (const feature of missionFeatureList(mission)) {
        if (feature.status === "complete" || feature.status === "skipped")
            continue;
        if (!areFeatureDependenciesSatisfied(feature, statuses))
            return undefined;
        const milestone = milestoneForFeature(mission, feature.id);
        return feature.status === "pending" ? (milestone ? { milestone, feature } : undefined) : undefined;
    }
    return undefined;
}
function currentRunnableMilestone(mission) {
    const milestones = missionMilestones(mission);
    return milestones.find((milestone) => milestone.id === mission.currentMilestoneId && milestone.status !== "complete" && milestone.status !== "skipped")
        ?? milestones.find((milestone) => milestone.status !== "complete" && milestone.status !== "skipped");
}
function findNextFeatureInMilestone(mission, milestone) {
    const statuses = featureStatusById(mission);
    for (const feature of milestone.features) {
        if (feature.status === "complete" || feature.status === "skipped")
            continue;
        if (!areFeatureDependenciesSatisfied(feature, statuses))
            return undefined;
        return feature.status === "pending" ? feature : undefined;
    }
    return undefined;
}
function milestoneWorkersComplete(milestone) {
    return milestone.features.every((feature) => feature.status === "complete" || feature.status === "skipped");
}
function milestoneAwaitingScrutinyValidation(milestone) {
    return milestoneWorkersComplete(milestone) && !milestone.validationState?.runId && !milestone.validationRunId;
}
function milestoneAwaitingUserTestingValidation(milestone) {
    return milestoneWorkersComplete(milestone) && isMilestoneUserTestingRequired(milestone) && Boolean(milestone.validationState?.runId || milestone.validationRunId) && !milestone.validationState?.userTestingRunId;
}
function featureHandoffExists(mission, feature) {
    return Boolean(feature.runId && fs.existsSync(path.join(missionDir(mission.cwd, mission.id), "runs", feature.runId, "handoff.json")));
}
function featureAwaitingValidation(mission, feature) {
    if (!featureHandoffExists(mission, feature))
        return false;
    if (feature.status === "running")
        return !feature.validationRunId;
    // Recovery repair may reset a worker-success feature to pending while preserving
    // its run/commit. If it has not had any validation attempt yet, validate that
    // existing implementation before launching later feature work.
    return feature.status === "pending" && Boolean(feature.commit) && !feature.validationRunId;
}
function featureAwaitingUserTesting(feature) {
    if (!isFeatureUserTestingRequired(feature))
        return false;
    if (feature.status !== "running")
        return false;
    if (!feature.validationRunId || feature.userTestingRunId)
        return false;
    // Backward compatibility for already-persisted F2 states before userTestingPending
    // existed: if a required feature is running with passed scrutiny and no user-testing
    // run yet, resume user-testing.
    return feature.userTestingPending !== false;
}
function findFeatureAwaitingUserTesting(mission) {
    const statuses = featureStatusById(mission);
    for (const feature of missionFeatureList(mission)) {
        if (feature.status === "complete" || feature.status === "skipped")
            continue;
        if (!areFeatureDependenciesSatisfied(feature, statuses))
            return undefined;
        if (featureAwaitingUserTesting(feature)) {
            const milestone = milestoneForFeature(mission, feature.id);
            return milestone ? { milestone, feature } : undefined;
        }
        if (featureAwaitingValidation(mission, feature))
            return undefined;
        if (feature.status === "pending")
            return undefined;
        return undefined;
    }
    return undefined;
}
function findFeatureAwaitingValidation(mission) {
    const statuses = featureStatusById(mission);
    for (const feature of missionFeatureList(mission)) {
        if (feature.status === "complete" || feature.status === "skipped")
            continue;
        if (!areFeatureDependenciesSatisfied(feature, statuses))
            return undefined;
        if (featureAwaitingValidation(mission, feature)) {
            const milestone = milestoneForFeature(mission, feature.id);
            return milestone ? { milestone, feature } : undefined;
        }
        // Sequential execution invariant: do not scan past an incomplete earlier
        // feature. If it is not ready for validation, normal worker selection or
        // no-runnable-work handling must deal with this feature before later ones.
        return undefined;
    }
    return undefined;
}
function incompleteFeatures(mission) {
    const statuses = featureStatusById(mission);
    const incomplete = [];
    for (const feature of missionFeatureList(mission)) {
        if (feature.status === "complete" || feature.status === "skipped")
            continue;
        const unsatisfiedDependencies = (feature.dependencies ?? []).filter((dependencyId) => {
            const dependencyStatus = statuses.get(dependencyId);
            return dependencyStatus !== "complete" && dependencyStatus !== "skipped";
        });
        const milestone = milestoneForFeature(mission, feature.id);
        if (milestone)
            incomplete.push({ milestone, feature, unsatisfiedDependencies });
    }
    return incomplete;
}
function normalizeBlockedFeatureForRetry(mission, feature) {
    if (feature.status === "failed" || feature.status === "running") {
        feature.status = "pending";
        feature.validationRunId = undefined;
        feature.userTestingRunId = undefined;
        feature.userTestingPending = false;
        return true;
    }
    return false;
}
function repairMissionExecutionGateState(_cwd, mission) {
    const reasons = [];
    let changed = false;
    const features = missionFeatureList(mission);
    const block = latestBlockFromArtifacts(mission);
    const recoveryPlan = computeRecoveryGatePlan({
        featureOrder: features.map((feature) => feature.id),
        featureStatusById: Object.fromEntries(features.map((feature) => [feature.id, feature.status])),
        blockedFeatureId: block?.featureId,
        currentFeatureId: mission.currentFeatureId,
        activeRunItemId: mission.activeRun?.itemId,
        missionStatus: mission.status,
    });
    if (!recoveryPlan.gateFeatureId)
        return { changed: false, reasons };
    const gateFeature = features.find((feature) => feature.id === recoveryPlan.gateFeatureId);
    if (!gateFeature)
        return { changed: false, reasons };
    const gateMilestone = milestoneForFeature(mission, gateFeature.id);
    if (!gateMilestone)
        return { changed: false, reasons };
    if (recoveryPlan.normalizeGateToPending && normalizeBlockedFeatureForRetry(mission, gateFeature)) {
        changed = true;
        reasons.push(`reset gate feature ${gateFeature.id} status to pending for retry`);
    }
    if (recoveryPlan.setCurrentFeatureToGate) {
        mission.currentFeatureId = gateFeature.id;
        changed = true;
        reasons.push(`set currentFeatureId to gate feature ${gateFeature.id}`);
    }
    if (mission.currentMilestoneId !== gateMilestone.id) {
        mission.currentMilestoneId = gateMilestone.id;
        changed = true;
        reasons.push(`set currentMilestoneId to ${gateMilestone.id}`);
    }
    if (mission.activeRun && recoveryPlan.clearActiveRun) {
        const staleRunId = mission.activeRun.runId;
        const activeItemId = mission.activeRun.itemId;
        clearActiveRunOwnership(mission);
        changed = true;
        reasons.push(`cleared stale activeRun ${staleRunId} beyond gate feature ${gateFeature.id}`);
        reasons.push(`reconciled active run item ${activeItemId} to blocked gate ${gateFeature.id}`);
    }
    if (recoveryPlan.forceBlockedStatus) {
        mission.status = "blocked";
        changed = true;
        reasons.push(`forced mission status to blocked until gate feature ${gateFeature.id} passes validation`);
    }
    return { changed, reasons };
}
function transitionFeaturePendingToWorkerRunning(mission, milestone, feature, runId) {
    feature.status = "running";
    feature.runId = runId;
    mission.status = "running";
    mission.currentMilestoneId = milestone.id;
    mission.currentFeatureId = feature.id;
    milestone.status = "running";
}
function transitionWorkerSuccessToValidatorRunning(mission, milestone, feature, runId) {
    feature.validationRunId = runId;
    feature.status = "running";
    mission.status = "running";
    mission.currentMilestoneId = milestone.id;
    mission.currentFeatureId = feature.id;
    milestone.status = "running";
}
function isFeatureUserTestingRequired(feature) {
    return feature.userTesting?.required === true;
}
function featureUserTestingInstructions(feature) {
    const instructions = feature.userTesting?.instructions;
    return typeof instructions === "string" && instructions.trim() ? instructions.trim() : undefined;
}
function isMilestoneUserTestingRequired(milestone) {
    return milestone.validationState?.userTesting?.required === true;
}
function milestoneUserTestingInstructions(milestone) {
    const instructions = milestone.validationState?.userTesting?.instructions;
    return typeof instructions === "string" && instructions.trim() ? instructions.trim() : undefined;
}
function setMilestoneUserTestingRunId(milestone, runId) {
    milestone.validationState = { ...milestone.validationState, userTestingRunId: runId };
}
function transitionMilestoneValidationFailureToBlocked(mission, milestone) {
    const failureCount = incrementMilestoneValidationFailureCount(milestone);
    const failureLimit = effectiveMilestoneValidationFailureLimit(mission, milestone);
    const limitExceeded = failureCount >= failureLimit;
    milestone.status = "failed";
    mission.status = "blocked";
    return {
        failureCount,
        failureLimit,
        limitExceeded,
        status: limitExceeded
            ? `validation failure limit exceeded (${failureCount}/${failureLimit}); orchestrator intervention required`
            : `validation failed (${failureCount}/${failureLimit}); orchestrator intervention required`,
    };
}
function clearResolvedFeatureBlock(mission, featureId) {
    if (mission.latestBlock?.featureId === featureId || mission.latestBlock?.failedItemId === featureId) {
        mission.latestBlock = undefined;
    }
}
function transitionValidatorPassToFeatureComplete(mission, milestone, feature) {
    feature.status = "complete";
    feature.userTestingPending = false;
    clearResolvedFeatureBlock(mission, feature.id);
    milestone.status = milestone.features.every((item) => item.status === "complete" || item.status === "skipped") ? "complete" : "pending";
    mission.status = "running";
}
function transitionValidatorFailToFeaturePendingForRetry(mission, feature) {
    feature.status = "pending";
    feature.userTestingPending = false;
    mission.status = "running";
}
function transitionFeatureToUserTestingRunning(mission, milestone, feature, runId) {
    feature.userTestingRunId = runId;
    feature.userTestingPending = false;
    feature.status = "running";
    mission.status = "running";
    mission.currentMilestoneId = milestone.id;
    mission.currentFeatureId = feature.id;
    milestone.status = "running";
}
function transitionUserTestingFailToFeaturePendingAndMissionBlocked(mission, feature) {
    feature.status = "pending";
    feature.userTestingPending = false;
    mission.status = "blocked";
}
function transitionMissionPauseAfterCurrent(mission, requestedAt) {
    mission.status = "paused";
    mission.pauseRequestedAt = requestedAt;
}
function transitionMissionResumeFromPause(mission) {
    mission.status = "running";
    mission.pauseRequestedAt = undefined;
}
function transitionMissionNoRunnablePendingWorkToBlocked(mission) {
    mission.status = "blocked";
}
function transitionMissionToComplete(mission) {
    mission.status = "complete";
    mission.latestBlock = undefined;
    for (const milestone of missionMilestones(mission)) {
        if (milestone.status !== "complete")
            milestone.status = "complete";
    }
}
function evaluateMissionLifecycleTransition(mission, lifecycle) {
    if (mission.status === "complete")
        return "complete";
    if (mission.status === "blocked" || mission.status === "failed")
        return "blocked";
    if (lifecycle.state === "interrupted")
        return "interrupted";
    return "active";
}
function writeNoRunnablePendingWorkReport(runDir, mission, pending) {
    ensureDir(runDir);
    const primary = pending[0];
    const report = {
        schemaVersion: 1,
        timestamp: nowIso(),
        missionId: mission.id,
        missionTitle: mission.title,
        reason: "No pending feature is currently runnable, but incomplete feature work remains.",
        pendingFeatures: pending.map(({ milestone, feature, unsatisfiedDependencies }) => ({
            milestoneId: milestone.id,
            milestoneTitle: milestone.title,
            featureId: feature.id,
            featureTitle: feature.title,
            status: feature.status,
            dependencies: feature.dependencies ?? [],
            unsatisfiedDependencies,
        })),
    };
    const reportJson = path.join(runDir, "unresolved-pending-work.json");
    const reportMd = path.join(runDir, "unresolved-pending-work.md");
    writeJson(reportJson, report);
    fs.writeFileSync(reportMd, [
        "# Unresolved pending mission work",
        "",
        "Mission execution stopped because no pending feature is runnable, but incomplete feature work remains. This usually means dependencies are unsatisfied, missing, failed, or otherwise invalid in the persisted plan.",
        "",
        ...report.pendingFeatures.flatMap((feature) => [
            `- ${feature.featureId} - ${feature.featureTitle} (${feature.status})`,
            `  - milestone: ${feature.milestoneId} - ${feature.milestoneTitle}`,
            `  - dependencies: ${feature.dependencies.length > 0 ? feature.dependencies.join(", ") : "none"}`,
            `  - unsatisfied dependencies: ${feature.unsatisfiedDependencies.length > 0 ? feature.unsatisfiedDependencies.join(", ") : "none"}`,
        ]),
        "",
    ].join("\n"));
    return {
        kind: "worker",
        missionId: mission.id,
        missionTitle: mission.title,
        milestoneId: primary?.milestone.id ?? mission.currentMilestoneId ?? "unknown",
        milestoneTitle: primary?.milestone.title ?? mission.currentMilestoneId ?? "Unknown milestone",
        featureId: primary?.feature.id,
        featureTitle: primary?.feature.title,
        runId: path.basename(runDir),
        runDir,
        exitCode: 0,
        status: "no runnable pending work",
        artifactPaths: existingPaths([reportJson, reportMd]),
    };
}
function shouldAutoResumeAfterPlanRevision(_cwd, _existingMission, _revisedMission) {
    // Plan revision is a control-plane mutation, not execution confirmation. Auto
    // resuming a blocked mission from mission_write_plan caused dogfooding runs to
    // continue while the orchestrator was still repairing state. Keep revisions
    // inert; users can explicitly resume via /missions run or Mission Control.
    return false;
}
async function runWorker(ctx, mission, milestone, feature, signal) {
    const dir = missionDir(mission.cwd, mission.id);
    const runId = `${String(Date.now())}-worker-${feature.id}`;
    const runDir = path.join(dir, "runs", runId);
    ensureDir(runDir);
    transitionFeaturePendingToWorkerRunning(mission, milestone, feature, runId);
    const ownership = setActiveRunOwnership(mission, { kind: "worker", itemId: feature.id, runId });
    saveMission(mission.cwd, mission);
    persistRunOwnershipArtifact(runDir, ownership);
    const workerSessionRecord = {
        schemaVersion: 1,
        missionId: mission.id,
        runId,
        role: "worker",
        featureId: feature.id,
        milestoneId: milestone.id,
        attempt: nextChildAttemptNumber(mission.cwd, mission.id, "worker", feature.id),
        status: "running",
        runDir,
        transcriptPath: path.join(runDir, "transcript.jsonl"),
        stderrPath: path.join(runDir, "stderr.txt"),
        sessionId: parseRunOwnershipSessionId(runDir),
        startedAt: nowIso(),
    };
    upsertChildSessionRecord(mission.cwd, mission.id, workerSessionRecord);
    updateWidget(ctx, mission);
    appendEvent(dir, "worker_started", { milestoneId: milestone.id, featureId: feature.id, runId, ownership, childSession: workerSessionRecord });
    const prompt = `Use the mission-worker skill and the mission-specific worker skill if present. Implement exactly one mission feature.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature: ${feature.id} - ${feature.title}\n\nFeature description:\n${feature.description}\n\nRequired outputs: commit code changes with git, then write handoff.json and handoff.md in the run directory. If blocked, write handoff files explaining why.

Do not stop after stating that you will implement. Use tools to complete the work before any final response. Your final response is allowed only after the commit and handoff artifacts exist, or after blocked handoff artifacts exist.`;
    const result = await runPiChild({
        cwd: mission.cwd,
        prompt,
        model: resolveRoleModel(mission.cwd, mission, "worker"),
        systemPromptFiles: [BASE_SKILLS.worker, path.join(dir, "skills/worker/SKILL.md")],
        transcriptFile: path.join(runDir, "transcript.jsonl"),
        signal,
        onUpdate: (text) => updateMissionRunStatus(ctx, `Worker ${feature.id}`, text),
    });
    fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
    appendEvent(dir, "worker_finished", { featureId: feature.id, runId, exitCode: result.exitCode });
    let handoff = undefined;
    let handoffSchemaError;
    const handoffFile = path.join(runDir, "handoff.json");
    if (fs.existsSync(handoffFile)) {
        try {
            const parsed = readJson(handoffFile);
            const validation = validateMissionArtifact("worker-handoff", parsed);
            if (validation.ok)
                handoff = parsed;
            else {
                handoffSchemaError = artifactValidationErrorSummary("worker-handoff", validation.issues);
                appendEvent(dir, "handoff_parse_error", { featureId: feature.id, error: handoffSchemaError, issues: validation.issues });
            }
        }
        catch (error) {
            handoffSchemaError = `Worker handoff.json parse error: ${String(error)}`;
            appendEvent(dir, "handoff_parse_error", { featureId: feature.id, error: String(error) });
        }
    }
    const dirty = await gitPorcelain(mission.cwd);
    const head = await gitHead(mission.cwd);
    if (!handoff && !handoffSchemaError && result.exitCode === 0 && !dirty) {
        handoff = synthesizeWorkerHandoffArtifacts(runDir, feature, result, head);
        appendEvent(dir, "worker_handoff_synthesized", { featureId: feature.id, runId, commit: head });
    }
    feature.commit = handoff?.commit || head;
    let block;
    if (result.exitCode !== 0 || !handoff || dirty) {
        const autoRetry = result.exitCode === 0 && !handoff && !handoffSchemaError && !dirty;
        feature.status = autoRetry ? "pending" : "failed";
        mission.status = autoRetry ? "running" : "blocked";
        appendEvent(dir, autoRetry ? "worker_missing_handoff_auto_retry" : "worker_failed", { featureId: feature.id, dirty, hasHandoff: Boolean(handoff), autoRetry });
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
            status: handoff?.status ?? (handoffSchemaError ? "invalid handoff schema" : (!handoff ? "missing handoff" : undefined)),
            dirty: dirty || undefined,
            artifactPaths: existingPaths([handoffFile, path.join(runDir, "handoff.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
        };
    }
    else if (handoff.status === "complete") {
        // Worker success completes the feature slice. Validation now runs at the
        // milestone boundary, not as a per-feature gate.
        feature.status = "complete";
        feature.userTestingPending = false;
        milestone.status = "running";
        mission.status = "running";
    }
    else {
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
    if (block)
        persistMissionBlock(dir, mission, block, classifyWorkerBlock(result, handoff, dirty));
    const workerTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
    upsertChildSessionRecord(mission.cwd, mission.id, {
        ...workerSessionRecord,
        status: block ? (block.status ?? "failed") : "complete",
        sessionId: workerTranscriptSession.sessionId ?? workerSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
        sessionPath: workerTranscriptSession.sessionPath ?? workerSessionRecord.sessionPath,
        finishedAt: nowIso(),
    });
    clearActiveRunOwnership(mission);
    saveMission(mission.cwd, mission);
    updateWidget(ctx, mission);
    return block;
}
function completedFeatureReviewContext(dir, milestone) {
    const completedFeatures = milestone.features.filter((feature) => feature.status === "complete");
    if (completedFeatures.length === 0)
        return "Completed features available for code review: none recorded.";
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
async function runValidator(ctx, mission, milestone, signal, targetFeature) {
    const dir = missionDir(mission.cwd, mission.id);
    const runId = `${String(Date.now())}-validator-${milestone.id}`;
    const runDir = path.join(dir, "runs", runId);
    ensureDir(runDir);
    if (targetFeature)
        transitionWorkerSuccessToValidatorRunning(mission, milestone, targetFeature, runId);
    else {
        setMilestoneValidationRunId(milestone, runId);
        milestone.status = "running";
        mission.status = "running";
        mission.currentMilestoneId = milestone.id;
        mission.currentFeatureId = undefined;
    }
    const ownership = setActiveRunOwnership(mission, { kind: "validator", validatorMode: "scrutiny", itemId: targetFeature?.id ?? milestone.id, runId });
    saveMission(mission.cwd, mission);
    persistRunOwnershipArtifact(runDir, ownership);
    const validatorSessionRecord = {
        schemaVersion: 1,
        missionId: mission.id,
        runId,
        role: "validator",
        validatorMode: "scrutiny",
        featureId: targetFeature?.id,
        milestoneId: milestone.id,
        attempt: nextChildAttemptNumber(mission.cwd, mission.id, "validator", targetFeature?.id, "scrutiny"),
        status: "running",
        runDir,
        transcriptPath: path.join(runDir, "transcript.jsonl"),
        stderrPath: path.join(runDir, "stderr.txt"),
        sessionId: parseRunOwnershipSessionId(runDir),
        startedAt: nowIso(),
    };
    upsertChildSessionRecord(mission.cwd, mission.id, validatorSessionRecord);
    updateWidget(ctx, mission);
    appendEvent(dir, "validator_started", { milestoneId: milestone.id, featureId: targetFeature?.id, runId, ownership, childSession: validatorSessionRecord });
    const featureReviewContext = targetFeature
        ? [`Feature attempt available for validation:`, `- ${targetFeature.id} - ${targetFeature.title}`, `  status: ${targetFeature.status}`, `  commit: ${targetFeature.commit ?? "not recorded"}`, `  worker run: ${targetFeature.runId ?? "not recorded"}`, `  run directory: ${targetFeature.runId ? path.join(dir, "runs", targetFeature.runId) : "not recorded"}`].join("\n")
        : completedFeatureReviewContext(dir, milestone);
    const prompt = `Use the mission-validator skill and the mission-specific scrutiny validator skill if present. Perform milestone-boundary scrutiny validation for this completed milestone.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\n${targetFeature ? `Current feature context (not the validation target): ${targetFeature.id} - ${targetFeature.title}\n\nFeature description:\n${targetFeature.description}\n` : ""}\n${featureReviewContext}\n\nPerform a per-feature adversarial code review for each completed feature listed above, using the recorded commits and handoff paths where available. Inspect relevant diffs/handoffs, assess whether tests and procedure were adequate, and report code-review defects or procedure findings. Also check the completed milestone against the validation contract and mission plan. Run appropriate checks. Write validation-report.json and validation-report.md in the run directory.

Do not stop after stating that you will validate. Use tools to complete the validation before any final response. Your final response is allowed only after validation-report.json and validation-report.md exist.`;
    const result = await runPiChild({
        cwd: mission.cwd,
        prompt,
        model: resolveRoleModel(mission.cwd, mission, "validator"),
        systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-scrutiny/SKILL.md")],
        transcriptFile: path.join(runDir, "transcript.jsonl"),
        signal,
        onUpdate: (text) => updateMissionRunStatus(ctx, `Validator ${targetFeature?.id ?? milestone.id}`, text),
    });
    fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
    let report = undefined;
    let reportSchemaError;
    const reportFile = path.join(runDir, "validation-report.json");
    if (fs.existsSync(reportFile)) {
        try {
            const parsed = readJson(reportFile);
            const validation = validateMissionArtifact("scrutiny-validation-report", parsed);
            if (validation.ok)
                report = parsed;
            else {
                reportSchemaError = artifactValidationErrorSummary("scrutiny-validation-report", validation.issues);
                appendEvent(dir, "validation_parse_error", { milestoneId: milestone.id, error: reportSchemaError, issues: validation.issues });
            }
        }
        catch (error) {
            reportSchemaError = `Scrutiny validation-report.json parse error: ${String(error)}`;
            appendEvent(dir, "validation_parse_error", { milestoneId: milestone.id, error: String(error) });
        }
    }
    if (!(result.exitCode === 0 && report?.status === "pass")) {
        report = ensureValidatorFailureReportArtifacts(runDir, milestone, result, report, reportSchemaError);
    }
    let block;
    if (result.exitCode === 0 && report?.status === "pass") {
        if (targetFeature) {
            if (isFeatureUserTestingRequired(targetFeature)) {
                targetFeature.status = "running";
                targetFeature.userTestingPending = true;
                mission.status = "running";
            }
            else
                transitionValidatorPassToFeatureComplete(mission, milestone, targetFeature);
        }
        else {
            milestone.status = isMilestoneUserTestingRequired(milestone) ? "running" : "complete";
        }
    }
    else {
        let milestoneFailure;
        if (targetFeature)
            transitionValidatorFailToFeaturePendingForRetry(mission, targetFeature);
        else
            milestoneFailure = transitionMilestoneValidationFailureToBlocked(mission, milestone);
        if (milestoneFailure)
            appendEvent(dir, "milestone_validation_failed", { milestoneId: milestone.id, runId, validatorMode: "scrutiny", failureCount: milestoneFailure.failureCount, failureLimit: milestoneFailure.failureLimit, limitExceeded: milestoneFailure.limitExceeded });
        block = {
            kind: "validator",
            validatorMode: "scrutiny",
            missionId: mission.id,
            missionTitle: mission.title,
            milestoneId: milestone.id,
            milestoneTitle: milestone.title,
            featureId: targetFeature?.id,
            featureTitle: targetFeature?.title,
            runId,
            runDir,
            exitCode: result.exitCode,
            status: milestoneFailure?.status ?? report?.status ?? (!report ? "missing validation report" : undefined),
            artifactPaths: existingPaths([reportFile, path.join(runDir, "validation-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
        };
    }
    if (block)
        persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
    appendEvent(dir, "validator_finished", { milestoneId: milestone.id, featureId: targetFeature?.id, runId, exitCode: result.exitCode, status: report?.status });
    const validatorTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
    upsertChildSessionRecord(mission.cwd, mission.id, {
        ...validatorSessionRecord,
        status: report?.status ?? (block ? "failed" : "pass"),
        sessionId: validatorTranscriptSession.sessionId ?? validatorSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
        sessionPath: validatorTranscriptSession.sessionPath ?? validatorSessionRecord.sessionPath,
        finishedAt: nowIso(),
    });
    clearActiveRunOwnership(mission);
    saveMission(mission.cwd, mission);
    updateWidget(ctx, mission);
    return block;
}
function ensureUserTestingFailureReportArtifacts(runDir, target, result, report, schemaError) {
    const reportFile = path.join(runDir, "user-testing-report.json");
    const reportMdFile = path.join(runDir, "user-testing-report.md");
    const hasStructuredReport = report && typeof report === "object" && typeof report.status === "string";
    if (hasStructuredReport)
        return report;
    const synthesized = {
        featureId: target.id,
        status: "inconclusive",
        summary: schemaError || result.finalText.trim() || "User-testing validator exited without a parseable user-testing-report.json artifact.",
        commandsRun: [],
    };
    writeJson(reportFile, synthesized);
    if (!fs.existsSync(reportMdFile))
        fs.writeFileSync(reportMdFile, `# User Testing Report\n\n- ${target.label}: ${target.id} - ${target.title}\n- Status: inconclusive\n\n## Summary\n${synthesized.summary}\n`);
    return synthesized;
}
async function runMilestoneUserTestingValidator(ctx, mission, milestone, signal) {
    const dir = missionDir(mission.cwd, mission.id);
    const runId = `${String(Date.now())}-user-testing-${milestone.id}`;
    const runDir = path.join(dir, "runs", runId);
    ensureDir(runDir);
    setMilestoneUserTestingRunId(milestone, runId);
    milestone.status = "running";
    mission.status = "running";
    mission.currentMilestoneId = milestone.id;
    mission.currentFeatureId = undefined;
    const ownership = setActiveRunOwnership(mission, { kind: "validator", validatorMode: "user-testing", itemId: milestone.id, runId });
    saveMission(mission.cwd, mission);
    persistRunOwnershipArtifact(runDir, ownership);
    const validatorSessionRecord = {
        schemaVersion: 1,
        missionId: mission.id,
        runId,
        role: "validator",
        validatorMode: "user-testing",
        milestoneId: milestone.id,
        attempt: nextChildAttemptNumber(mission.cwd, mission.id, "validator", milestone.id, "user-testing"),
        status: "running",
        runDir,
        transcriptPath: path.join(runDir, "transcript.jsonl"),
        stderrPath: path.join(runDir, "stderr.txt"),
        sessionId: parseRunOwnershipSessionId(runDir),
        startedAt: nowIso(),
    };
    upsertChildSessionRecord(mission.cwd, mission.id, validatorSessionRecord);
    updateWidget(ctx, mission);
    appendEvent(dir, "user_testing_started", { milestoneId: milestone.id, runId, ownership, childSession: validatorSessionRecord });
    const instructions = milestoneUserTestingInstructions(milestone);
    const prompt = `Use the mission-validator skill and the mission-specific user-testing validator skill if present. Execute user-testing validation for this completed milestone.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\n\n${completedFeatureReviewContext(dir, milestone)}\n\nRequired behavior:\n- Keep testing approach generic across CLI, TUI, API, web, docs/config, and other project types.\n- Do not assume browser-only workflows.\n- Validate the integrated milestone outcome, not an individual feature gate.\n${instructions ? `\nMilestone-specific user-testing instructions:\n${instructions}\n` : ""}\nWrite user-testing-report.json and user-testing-report.md in the run directory. Use the milestone id as featureId in user-testing-report.json for schema compatibility.\n\nDo not stop after stating that you will validate. Use tools to complete the validation before any final response. Your final response is allowed only after user-testing-report.json and user-testing-report.md exist.`;
    const result = await runPiChild({
        cwd: mission.cwd,
        model: resolveRoleModel(mission.cwd, mission, "validator"),
        systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-user-testing/SKILL.md")],
        prompt,
        transcriptFile: path.join(runDir, "transcript.jsonl"),
        signal,
        onUpdate: (text) => updateMissionRunStatus(ctx, `User-testing ${milestone.id}`, text),
    });
    fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
    let report = undefined;
    let reportSchemaError;
    const reportFile = path.join(runDir, "user-testing-report.json");
    if (fs.existsSync(reportFile)) {
        try {
            const parsed = readJson(reportFile);
            const validation = validateMissionArtifact("user-testing-report", parsed);
            if (validation.ok)
                report = parsed;
            else {
                reportSchemaError = artifactValidationErrorSummary("user-testing-report", validation.issues);
                appendEvent(dir, "user_testing_parse_error", { milestoneId: milestone.id, error: reportSchemaError, issues: validation.issues });
            }
        }
        catch (error) {
            reportSchemaError = `User-testing report parse error: ${String(error)}`;
            appendEvent(dir, "user_testing_parse_error", { milestoneId: milestone.id, error: String(error) });
        }
    }
    if (!(result.exitCode === 0 && report?.status === "pass"))
        report = ensureUserTestingFailureReportArtifacts(runDir, { id: milestone.id, title: milestone.title, label: "Milestone" }, result, report, reportSchemaError);
    appendEvent(dir, "user_testing_finished", { milestoneId: milestone.id, runId, exitCode: result.exitCode, status: report?.status });
    let block;
    if (result.exitCode === 0 && report?.status === "pass")
        milestone.status = "complete";
    else {
        const milestoneFailure = transitionMilestoneValidationFailureToBlocked(mission, milestone);
        appendEvent(dir, "milestone_validation_failed", { milestoneId: milestone.id, runId, validatorMode: "user-testing", failureCount: milestoneFailure.failureCount, failureLimit: milestoneFailure.failureLimit, limitExceeded: milestoneFailure.limitExceeded });
        block = { kind: "validator", validatorMode: "user-testing", missionId: mission.id, missionTitle: mission.title, milestoneId: milestone.id, milestoneTitle: milestone.title, runId, runDir, exitCode: result.exitCode, status: milestoneFailure.status, artifactPaths: existingPaths([reportFile, path.join(runDir, "user-testing-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]) };
    }
    if (block)
        persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
    const validatorTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
    upsertChildSessionRecord(mission.cwd, mission.id, { ...validatorSessionRecord, status: report?.status ?? (block ? "failed" : "pass"), sessionId: validatorTranscriptSession.sessionId ?? validatorSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir), sessionPath: validatorTranscriptSession.sessionPath ?? validatorSessionRecord.sessionPath, finishedAt: nowIso() });
    clearActiveRunOwnership(mission);
    saveMission(mission.cwd, mission);
    updateWidget(ctx, mission);
    return block;
}
async function runUserTestingValidator(ctx, mission, milestone, feature, signal) {
    const dir = missionDir(mission.cwd, mission.id);
    const runId = `${String(Date.now())}-user-testing-${feature.id}`;
    const runDir = path.join(dir, "runs", runId);
    ensureDir(runDir);
    transitionFeatureToUserTestingRunning(mission, milestone, feature, runId);
    const ownership = setActiveRunOwnership(mission, { kind: "validator", validatorMode: "user-testing", itemId: feature.id, runId });
    saveMission(mission.cwd, mission);
    persistRunOwnershipArtifact(runDir, ownership);
    const validatorSessionRecord = {
        schemaVersion: 1,
        missionId: mission.id,
        runId,
        role: "validator",
        validatorMode: "user-testing",
        featureId: feature.id,
        milestoneId: milestone.id,
        attempt: nextChildAttemptNumber(mission.cwd, mission.id, "validator", feature.id, "user-testing"),
        status: "running",
        runDir,
        transcriptPath: path.join(runDir, "transcript.jsonl"),
        stderrPath: path.join(runDir, "stderr.txt"),
        sessionId: parseRunOwnershipSessionId(runDir),
        startedAt: nowIso(),
    };
    upsertChildSessionRecord(mission.cwd, mission.id, validatorSessionRecord);
    updateWidget(ctx, mission);
    appendEvent(dir, "user_testing_started", { milestoneId: milestone.id, featureId: feature.id, runId, ownership, childSession: validatorSessionRecord });
    const instructions = featureUserTestingInstructions(feature);
    const prompt = `Use the mission-validator skill and the mission-specific user-testing validator skill if present. Execute legacy feature-scoped user-testing validation for this compatibility path. Normal mission execution validates user testing at the milestone boundary.\n\nMission directory: ${dir}\nRun directory: ${runDir}\nTarget repository cwd: ${mission.cwd}\nMilestone: ${milestone.id} - ${milestone.title}\nFeature context: ${feature.id} - ${feature.title}\n\nFeature description:\n${feature.description}\n\nRequired behavior:\n- Keep testing approach generic across CLI, TUI, API, web, docs/config, and other project types.\n- Do not assume browser-only workflows.\n- Use feature-specific instructions when provided.\n${instructions ? `\nFeature-specific user-testing instructions:\n${instructions}\n` : ""}\nWrite user-testing-report.json and user-testing-report.md in the run directory.\n\nDo not stop after stating that you will validate. Use tools to complete the validation before any final response. Your final response is allowed only after user-testing-report.json and user-testing-report.md exist.`;
    const result = await runPiChild({
        cwd: mission.cwd,
        model: resolveRoleModel(mission.cwd, mission, "validator"),
        systemPromptFiles: [BASE_SKILLS.validator, path.join(dir, "skills/validator-user-testing/SKILL.md")],
        prompt,
        transcriptFile: path.join(runDir, "transcript.jsonl"),
        signal,
        onUpdate: (text) => updateMissionRunStatus(ctx, `User-testing ${feature.id}`, text),
    });
    fs.writeFileSync(path.join(runDir, "stderr.txt"), result.stderr);
    let report = undefined;
    let reportSchemaError;
    const reportFile = path.join(runDir, "user-testing-report.json");
    if (fs.existsSync(reportFile)) {
        try {
            const parsed = readJson(reportFile);
            const validation = validateMissionArtifact("user-testing-report", parsed);
            if (validation.ok)
                report = parsed;
            else {
                reportSchemaError = artifactValidationErrorSummary("user-testing-report", validation.issues);
                appendEvent(dir, "user_testing_parse_error", { featureId: feature.id, error: reportSchemaError, issues: validation.issues });
            }
        }
        catch (error) {
            reportSchemaError = `User-testing report parse error: ${String(error)}`;
            appendEvent(dir, "user_testing_parse_error", { featureId: feature.id, error: String(error) });
        }
    }
    if (!(result.exitCode === 0 && report?.status === "pass"))
        report = ensureUserTestingFailureReportArtifacts(runDir, { id: feature.id, title: feature.title, label: "Feature" }, result, report, reportSchemaError);
    appendEvent(dir, "user_testing_finished", { milestoneId: milestone.id, featureId: feature.id, runId, exitCode: result.exitCode, status: report?.status });
    let block;
    if (result.exitCode === 0 && report?.status === "pass")
        transitionValidatorPassToFeatureComplete(mission, milestone, feature);
    else {
        transitionUserTestingFailToFeaturePendingAndMissionBlocked(mission, feature);
        block = {
            kind: "validator",
            validatorMode: "user-testing",
            missionId: mission.id,
            missionTitle: mission.title,
            milestoneId: milestone.id,
            milestoneTitle: milestone.title,
            featureId: feature.id,
            featureTitle: feature.title,
            runId,
            runDir,
            exitCode: result.exitCode,
            status: report?.status ?? "missing user-testing report",
            artifactPaths: existingPaths([reportFile, path.join(runDir, "user-testing-report.md"), path.join(runDir, "transcript.jsonl"), path.join(runDir, "stderr.txt")]),
        };
    }
    if (block)
        persistMissionBlock(dir, mission, block, classifyValidatorBlock(result, report));
    const validatorTranscriptSession = parseTranscriptSessionIdentity(path.join(runDir, "transcript.jsonl"));
    upsertChildSessionRecord(mission.cwd, mission.id, {
        ...validatorSessionRecord,
        status: report?.status ?? (block ? "failed" : "pass"),
        sessionId: validatorTranscriptSession.sessionId ?? validatorSessionRecord.sessionId ?? parseRunOwnershipSessionId(runDir),
        sessionPath: validatorTranscriptSession.sessionPath ?? validatorSessionRecord.sessionPath,
        finishedAt: nowIso(),
    });
    clearActiveRunOwnership(mission);
    saveMission(mission.cwd, mission);
    updateWidget(ctx, mission);
    return block;
}
// Mission Control concurrency/control decision (F1/F7/F11): ctx.ui.custom()
// returns a Promise that settles only when the custom component calls
// done()/closes, so awaiting it before or during runMission would make mission
// execution wait for the user to close the UI. Auto-open Mission Control
// fire-and-forget and keep runMission as the durable execution owner. Closing
// Mission Control only disposes the UI; it does not abort ctx.signal or any
// child worker/validator process. Mutating controls are explicit action-dispatcher
// calls; pause is a durable pause-after-current request, not a child-process kill.
function autoOpenMissionControl(ctx, mission, pi) {
    if (!ctx.hasUI)
        return;
    const state = buildOrchestratorState(ctx.cwd, mission, {
        activeMissionId: mission.id,
        activePlanningMissionId: undefined,
        activeRunningMissionId: mission.id,
    });
    void openMissionControl(ctx, state, undefined, pi).catch((error) => {
        ctx.ui.notify(`Mission Control failed to open: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
}
function transitionInterruptedOrStaleRunToPausedForResume(mission, run) {
    for (const milestone of missionMilestones(mission)) {
        if (run?.kind === "validator" && milestone.id === run.itemId && milestone.status === "running")
            milestone.status = "pending";
        for (const feature of milestone.features) {
            if (run?.kind === "worker" && feature.id === run.itemId && feature.status === "running")
                feature.status = "pending";
            if (run?.kind === "validator" && feature.validationRunId === run.runId && feature.status === "running")
                feature.status = "pending";
            if (run?.validatorMode === "user-testing" && feature.userTestingRunId === run.runId && feature.status === "running") {
                feature.userTestingPending = true;
                feature.userTestingRunId = undefined;
            }
        }
        if (milestone.status === "running" && !milestone.features.some((feature) => feature.status === "running"))
            milestone.status = "pending";
    }
    mission.status = "paused";
    clearActiveRunOwnership(mission);
}
function resetInterruptedRunForResume(ctx, mission, lifecycle) {
    const dir = missionDir(mission.cwd, mission.id);
    const run = lifecycle.run;
    const before = {
        status: mission.status,
        currentMilestoneId: mission.currentMilestoneId,
        currentFeatureId: mission.currentFeatureId,
        activeRun: mission.activeRun,
        runId: run?.runId,
        runKind: run?.kind,
        runItemId: run?.itemId,
        reason: lifecycle.reason,
    };
    transitionInterruptedOrStaleRunToPausedForResume(mission, run);
    mission.updatedAt = nowIso();
    appendEvent(dir, "mission_interrupted_run_reset_for_resume", { missionId: mission.id, before });
    clearMissionRunStatus(ctx);
    saveMission(mission.cwd, mission);
    updateWidget(ctx, mission);
    return mission;
}
function startMissionInBackground(missionId, ctx, pi, source) {
    const existing = loadMission(ctx.cwd, missionId);
    const missionCwd = existing.cwd;
    const lifecycle = classifyMissionRunLifecycle(missionCwd, existing);
    if (isMissionRunActive(missionCwd, missionId))
        return { ok: false, text: `Mission execution is already active for ${missionId}.` };
    if (existing.status === "running" && lifecycle.state === "interrupted")
        resetInterruptedRunForResume(ctx, existing, lifecycle);
    const dir = missionDir(missionCwd, missionId);
    appendEvent(dir, "mission_background_execution_requested", { missionId, source });
    void runMission(missionId, ctx, pi, { detached: true }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        try {
            const mission = loadMission(missionCwd, missionId);
            mission.status = mission.status === "complete" ? mission.status : "blocked";
            clearActiveRunOwnership(mission);
            saveMission(mission.cwd, mission);
            appendEvent(dir, "mission_background_execution_failed", { missionId, source, error: message });
            updateWidget(ctx, mission);
        }
        catch {
            appendEvent(dir, "mission_background_execution_failed", { missionId, source, error: message, artifactUpdateFailed: true });
        }
        clearMissionRunStatus(ctx);
        ctx.ui.notify(`Mission execution failed: ${message}`, "error");
    });
    return { ok: true, text: `Mission execution started in background for ${missionId}. Mission Control remains interactive.` };
}
function executeRunnerCommand(input, ctx, pi, state) {
    const missionId = input.missionId || activeMissionFromState(ctx.cwd, state)?.id || latestMission(ctx.cwd)?.id;
    if (!missionId)
        return { ok: false, text: "No mission found." };
    const mission = loadMission(ctx.cwd, missionId);
    const missionCwd = mission.cwd;
    const dir = missionDir(missionCwd, missionId);
    if (input.command === "status")
        return { ok: true, text: summarizeMission(mission), details: { missionId } };
    if (input.command === "start" || input.command === "resume") {
        return startMissionInBackground(missionId, ctx, pi, input.source);
    }
    if (input.command === "pause-after-current") {
        if (mission.status !== "running")
            return { ok: false, text: `Mission ${missionId} is not running.` };
        return requestMissionPauseAfterCurrent(missionCwd, mission, input.source);
    }
    if (input.command === "cancel-current-child") {
        const canceled = tryCancelCurrentChild(missionCwd, missionId);
        appendEvent(dir, "mission_current_child_cancel_requested", { missionId, source: input.source, canceled });
        return canceled
            ? { ok: true, text: `Cancellation requested for current child of ${missionId}.` }
            : { ok: false, text: `No cancelable child is active for ${missionId}.` };
    }
    if (input.command === "retry-feature") {
        if (isMissionRunActive(missionCwd, missionId))
            return { ok: false, text: `Mission ${missionId} is currently running.` };
        const featureId = input.featureId || mission.currentFeatureId;
        if (!featureId)
            return { ok: false, text: "No feature id provided for retry." };
        const feature = missionFeatureList(mission).find((item) => item.id === featureId);
        if (!feature)
            return { ok: false, text: `Feature not found: ${featureId}.` };
        feature.status = "pending";
        feature.runId = undefined;
        feature.validationRunId = undefined;
        feature.userTestingRunId = undefined;
        feature.userTestingPending = false;
        mission.status = "blocked";
        mission.updatedAt = nowIso();
        saveMission(missionCwd, mission);
        appendEvent(dir, "mission_feature_retry_requested", { missionId, featureId, source: input.source });
        return { ok: true, text: `Feature ${featureId} reset to pending for retry.` };
    }
    if (input.command === "block") {
        if (isMissionRunActive(missionCwd, missionId))
            return { ok: false, text: `Mission ${missionId} is currently running.` };
        mission.status = "blocked";
        mission.updatedAt = nowIso();
        saveMission(missionCwd, mission);
        appendEvent(dir, "mission_block_manual", { missionId, source: input.source, reason: input.reason });
        return { ok: true, text: `Mission ${missionId} marked blocked.` };
    }
    if (input.command === "unblock") {
        if (isMissionRunActive(missionCwd, missionId))
            return { ok: false, text: `Mission ${missionId} is currently running.` };
        if (mission.status !== "blocked")
            return { ok: false, text: `Mission ${missionId} is not blocked.` };
        mission.status = "paused";
        mission.updatedAt = nowIso();
        saveMission(missionCwd, mission);
        appendEvent(dir, "mission_unblock_manual", { missionId, source: input.source, reason: input.reason });
        return { ok: true, text: `Mission ${missionId} unblocked to paused state.` };
    }
    return { ok: false, text: `Unsupported runner command: ${input.command}` };
}
class MissionExecutionRunner {
    ctx;
    pi;
    missionId;
    dir;
    childSignal;
    constructor(ctx, pi, missionId, dir, childSignal) {
        this.ctx = ctx;
        this.pi = pi;
        this.missionId = missionId;
        this.dir = dir;
        this.childSignal = childSignal;
    }
    async run() {
        while (true) {
            let mission = loadMission(this.ctx.cwd, this.missionId);
            const milestone = currentRunnableMilestone(mission);
            if (!milestone)
                break;
            const nextFeature = findNextFeatureInMilestone(mission, milestone);
            if (nextFeature) {
                const workerBlock = await runWorker(this.ctx, mission, milestone, nextFeature, this.childSignal);
                mission = loadMission(this.ctx.cwd, this.missionId);
                if (mission.status === "blocked" || mission.status === "failed") {
                    this.ctx.ui.notify(`Mission blocked. See ${this.dir}`, "error");
                    clearMissionRunStatus(this.ctx);
                    if (workerBlock)
                        await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, workerBlock, buildOrchestratorState);
                    return;
                }
                if (workerBlock)
                    appendEvent(this.dir, "worker_failure_auto_retry", { featureId: nextFeature.id, runId: workerBlock.runId, status: workerBlock.status });
                if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `worker:${nextFeature.id}`))
                    return;
                continue;
            }
            if (milestoneAwaitingScrutinyValidation(milestone)) {
                const validatorBlock = await runValidator(this.ctx, mission, milestone, this.childSignal);
                mission = loadMission(this.ctx.cwd, this.missionId);
                if (mission.status === "blocked" || mission.status === "failed") {
                    this.ctx.ui.notify(`Validation blocked mission. See ${this.dir}`, "error");
                    clearMissionRunStatus(this.ctx);
                    if (validatorBlock)
                        await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, validatorBlock, buildOrchestratorState);
                    return;
                }
                if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `validator:${milestone.id}`))
                    return;
                continue;
            }
            if (milestoneAwaitingUserTestingValidation(milestone)) {
                const userTestingBlock = await runMilestoneUserTestingValidator(this.ctx, mission, milestone, this.childSignal);
                mission = loadMission(this.ctx.cwd, this.missionId);
                if (mission.status === "blocked" || mission.status === "failed") {
                    this.ctx.ui.notify(`User testing blocked mission. See ${this.dir}`, "error");
                    clearMissionRunStatus(this.ctx);
                    if (userTestingBlock)
                        await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, userTestingBlock, buildOrchestratorState);
                    return;
                }
                if (applyPauseAfterCurrentIfRequested(this.ctx, this.missionId, `user-testing:${milestone.id}`))
                    return;
                continue;
            }
            break;
        }
        const mission = loadMission(this.ctx.cwd, this.missionId);
        const pending = incompleteFeatures(mission);
        if (pending.length > 0) {
            transitionMissionNoRunnablePendingWorkToBlocked(mission);
            const runId = `${String(Date.now())}-blocked-no-runnable-pending-work`;
            const runDir = path.join(this.dir, "runs", runId);
            const block = writeNoRunnablePendingWorkReport(runDir, mission, pending);
            persistMissionBlock(this.dir, mission, block, "no_runnable_pending_work");
            saveMission(this.ctx.cwd, mission);
            updateWidget(this.ctx, mission);
            this.ctx.ui.notify(`Mission blocked: pending work remains but no feature is runnable. See ${runDir}`, "error");
            clearMissionRunStatus(this.ctx);
            await dispatchMissionBlockRecovery(this.ctx, this.pi, mission, block, buildOrchestratorState);
            return;
        }
        transitionMissionToComplete(mission);
        saveMission(this.ctx.cwd, mission);
        appendEvent(this.dir, "mission_complete", {});
        updateWidget(this.ctx, mission);
        clearMissionRunStatus(this.ctx);
        this.ctx.ui.notify(`Mission complete: ${mission.title}`, "info");
    }
}
async function runMission(args, ctx, pi, options = {}) {
    const id = args.trim() || latestMission(ctx.cwd)?.id;
    if (!id) {
        ctx.ui.notify("No mission found. Start with /missions [goal] and persist a plan first.", "warning");
        return;
    }
    let mission = loadMission(ctx.cwd, id);
    const missionCwd = mission.cwd;
    const dir = missionDir(missionCwd, id);
    const gateRepair = repairMissionExecutionGateState(missionCwd, mission);
    if (gateRepair.changed) {
        saveMission(missionCwd, mission);
        appendEvent(dir, "mission_recovery_gate_repaired", { missionId: mission.id, reasons: gateRepair.reasons, latestBlock: mission.latestBlock });
        ctx.ui.notify(`Mission recovery repaired execution gate: ${gateRepair.reasons.join("; ")}`, "warning");
    }
    if (mission.status === "planning") {
        ctx.ui.notify("Mission is still in interactive planning. Ask the orchestrator to persist a runnable plan first.", "warning");
        return;
    }
    if (mission.status === "complete") {
        ctx.ui.notify("Mission is already complete.", "info");
        return;
    }
    if (mission.status === "running") {
        const lifecycle = classifyMissionRunLifecycle(missionCwd, mission);
        if (lifecycle.state === "interrupted") {
            mission = resetInterruptedRunForResume(ctx, mission, lifecycle);
            ctx.ui.notify(`Interrupted mission run reset for resume: ${lifecycle.reason}`, "warning");
        }
        else {
            const pendingPause = readMissionPauseRequest(missionCwd, mission.id);
            ctx.ui.notify(pendingPause ? "Mission is running with a pending pause-after-current request. Wait for the current worker/validator to finish before resuming." : "Mission is already running.", "warning");
            return;
        }
    }
    const runKey = activeMissionRunKey(missionCwd, id);
    if (ACTIVE_MISSION_RUNS.has(runKey)) {
        ctx.ui.notify("Mission execution is already active for this mission.", "warning");
        return;
    }
    const lockAcquire = await acquireRunnerLock(missionCwd, mission);
    if (!lockAcquire.ok) {
        ctx.ui.notify(lockAcquire.reason, "warning");
        return;
    }
    if (lockAcquire.recoveredStale) {
        appendEvent(dir, "mission_runner_lock_recovered", { missionId: mission.id, previousOwner: lockAcquire.lock.recoveredFrom, newOwnerPid: process.pid, newOwnerSessionMarker: parentSessionMarker() });
    }
    ACTIVE_MISSION_RUNS.add(runKey);
    const heartbeat = setInterval(() => {
        try {
            upsertRunnerLockHeartbeat(missionCwd, id);
        }
        catch {
            // Best effort heartbeat persistence.
        }
    }, RUNNER_HEARTBEAT_INTERVAL_MS);
    try {
        if (await gitPorcelain(mission.cwd)) {
            const ok = await ctx.ui.confirm("Dirty git status", "Repository has uncommitted changes. Continue anyway? Workers must leave it clean after each feature.");
            if (!ok)
                return;
        }
        if (!hasMissionExecutionStarted(missionCwd, mission)) {
            mission = markMissionExecutionStarted(mission);
            saveMission(missionCwd, mission);
            appendEvent(dir, "mission_execution_started", { missionId: mission.id });
        }
        if (hasMissionPauseRequest(missionCwd, mission.id)) {
            clearMissionPauseRequest(missionCwd, mission.id);
            appendEvent(dir, "mission_resume_requested", { missionId: mission.id, source: "runMission" });
        }
        if (mission.status === "paused") {
            transitionMissionResumeFromPause(mission);
            saveMission(missionCwd, mission);
        }
        autoOpenMissionControl(ctx, mission, pi);
        ctx.ui.notify(`Running mission ${mission.title}`, "info");
        const childAbortController = new AbortController();
        const childSignal = childAbortController.signal;
        if (!options.detached && ctx.signal) {
            const abortFromParent = () => childAbortController.abort();
            if (ctx.signal.aborted)
                abortFromParent();
            else
                ctx.signal.addEventListener("abort", abortFromParent, { once: true });
        }
        ACTIVE_MISSION_CHILD_ABORTERS.set(runKey, childAbortController);
        const runner = new MissionExecutionRunner(ctx, pi, id, dir, childSignal);
        await runner.run();
    }
    finally {
        clearInterval(heartbeat);
        releaseRunnerLock(missionCwd, id, "runMission_finished");
        ACTIVE_MISSION_CHILD_ABORTERS.delete(runKey);
        ACTIVE_MISSION_RUNS.delete(runKey);
    }
}
export const __testing = {
    normalizeMissionShape,
    missionForPersistence,
    effectiveMilestoneValidationFailureLimit,
    milestoneValidationFailureCount,
    incrementMilestoneValidationFailureCount,
    currentRunnableMilestone,
    findNextFeatureInMilestone,
    milestoneAwaitingScrutinyValidation,
    milestoneAwaitingUserTestingValidation,
    normalizeValidationContractJson,
    transitionMilestoneValidationFailureToBlocked,
    transitionMissionToComplete,
    saveMission,
    loadMission,
};
export default function missionsExtension(pi) {
    let orchestratorState;
    let activePlanningId;
    let activeMissionId;
    let activeRunningId;
    const persistOrchestratorState = (cwd, mission, overrides = {}) => {
        const hasOverride = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
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
            if (!ok)
                return { content: [{ type: "text", text: "Mission start canceled by user." }], details: { missionId } };
            activeRunningId = missionId;
            persistOrchestratorState(ctx.cwd, mission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: missionId });
            ensureOfficialOrchestratorSessionRecord(ctx, mission);
            const result = executeRunnerCommand({ command: "start", missionId, source: "mission_start_execution_tool" }, ctx, pi, orchestratorState);
            return { content: [{ type: "text", text: result.text }], details: { missionId }, isError: !result.ok };
        },
    });
    pi.registerTool({
        name: "mission_runner_command",
        label: "Mission Runner Command",
        description: "Execute deterministic mission runner commands (start, pause-after-current, resume, retry feature, block/unblock where safe, status, cancel current child when supported).",
        parameters: Type.Object({
            command: Type.Union([
                Type.Literal("start"),
                Type.Literal("pause-after-current"),
                Type.Literal("resume"),
                Type.Literal("retry-feature"),
                Type.Literal("block"),
                Type.Literal("unblock"),
                Type.Literal("status"),
                Type.Literal("cancel-current-child"),
            ]),
            missionId: Type.Optional(Type.String()),
            featureId: Type.Optional(Type.String()),
            reason: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const command = params.command;
            const missionId = params.missionId || activeMissionId || activePlanningId || activeMissionFromState(ctx.cwd, orchestratorState)?.id || latestMission(ctx.cwd)?.id;
            if (!missionId)
                return { content: [{ type: "text", text: "No mission found." }], details: {}, isError: true };
            if ((command === "start" || command === "resume" || command === "cancel-current-child") && ctx.hasUI) {
                const ok = await ctx.ui.confirm(command === "cancel-current-child" ? "Cancel current mission child?" : command === "resume" ? "Resume mission execution?" : "Start mission execution?", `Mission ${missionId}\n\nCommand: ${command}. Workers may modify files and create commits.`);
                if (!ok)
                    return { content: [{ type: "text", text: `Mission runner command canceled: ${command}.` }], details: { missionId, command } };
            }
            if (command === "start" || command === "resume") {
                activeRunningId = missionId;
                const mission = loadMission(ctx.cwd, missionId);
                persistOrchestratorState(ctx.cwd, mission, { activeMissionId: missionId, activePlanningMissionId: undefined, activeRunningMissionId: missionId });
                ensureOfficialOrchestratorSessionRecord(ctx, mission);
            }
            const result = executeRunnerCommand({ command, missionId, featureId: params.featureId, reason: params.reason, source: "mission_runner_command_tool" }, ctx, pi, orchestratorState);
            if (result.ok && command === "status")
                ctx.ui.notify(result.text, "info");
            else
                ctx.ui.notify(result.text, result.ok ? "info" : "warning");
            return { content: [{ type: "text", text: result.text }], details: { missionId, command, ...(result.details && typeof result.details === "object" ? result.details : {}) }, isError: !result.ok };
        },
    });
    pi.registerTool({
        name: "mission_write_plan",
        label: "Write or Revise Mission Plan",
        description: "Persist the current interactive mission planning draft or revise the active mission plan. Omit missionId to use the current session's active planning/running mission; never-started missions are not run, but previously-started blocked missions auto-resume when a revision leaves pending runnable work.",
        parameters: Type.Object({
            missionId: Type.Optional(Type.String()),
            mission: Type.Any({ description: "Complete mission.json object matching the mission-plan schema." }),
            objectiveMd: Type.String({ description: "Human-readable objective, constraints, non-goals, and assumptions." }),
            featuresJson: Type.Any({ description: "Ordered feature list derived from milestone features." }),
            validationContractJson: Type.Any({ description: "Implementation-independent validation assertions." }),
            validationContractMd: Type.String({ description: "Human-readable validation contract." }),
            workerSkillMd: Type.String({ description: "Mission-specific worker SKILL.md content." }),
            validatorScrutinySkillMd: Type.String({ description: "Mission-specific scrutiny validator SKILL.md content." }),
            validatorUserTestingSkillMd: Type.Optional(Type.String({ description: "Mission-specific QA/user-testing validator SKILL.md content, if applicable." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const active = activeMissionFromState(ctx.cwd, orchestratorState);
            const requestedMission = params.mission;
            const explicitMissionId = params.missionId || requestedMission.id;
            const activeCandidateId = activePlanningId || activeMissionId || active?.id;
            let missionId = explicitMissionId || activeCandidateId || createPlanningMission(ctx.cwd).id;
            if (!explicitMissionId && activeCandidateId) {
                try {
                    const candidate = loadMission(ctx.cwd, activeCandidateId);
                    if (candidate.status === "complete" || candidate.status === "failed")
                        missionId = createPlanningMission(ctx.cwd).id;
                }
                catch {
                    // Ignore missing candidate and continue with generated/new id.
                }
            }
            const dir = missionDir(ctx.cwd, missionId);
            const existingMission = fs.existsSync(path.join(dir, "mission.json")) ? loadMission(ctx.cwd, missionId) : undefined;
            const seedMission = existingMission ?? createPlanningMission(ctx.cwd, missionId);
            ensureDir(path.join(dir, "plan"));
            ensureDir(path.join(dir, "skills/worker"));
            ensureDir(path.join(dir, "skills/validator-scrutiny"));
            ensureDir(path.join(dir, "skills/validator-user-testing"));
            const mission = normalizeMissionShape(params.mission);
            mission.id = missionId;
            mission.cwd = existingMission?.cwd || (typeof requestedMission.cwd === "string" && requestedMission.cwd.trim() ? requestedMission.cwd.trim() : ctx.cwd);
            mission.schemaVersion = 1;
            mission.status = persistedPlanStatus(mission.status, existingMission);
            mission.updatedAt = nowIso();
            if (!mission.createdAt)
                mission.createdAt = seedMission.createdAt;
            mission.models = normalizeRoleModels(mission.models ?? seedMission.models);
            if (existingMission &&
                mission.status !== "planned" &&
                mission.status !== "planning" &&
                !mission.executionStartedAt &&
                hasMissionExecutionStarted(ctx.cwd, existingMission))
                mission.executionStartedAt = existingMission.executionStartedAt ?? nowIso();
            if (!existingMission) {
                const globalModels = readMissionGlobalSettings(ctx.cwd).models;
                for (const role of MISSION_ROLES)
                    if (mission.models[role] === "default")
                        mission.models[role] = globalModels[role];
            }
            writeJson(path.join(dir, "mission.json"), missionForPersistence(mission));
            fs.writeFileSync(path.join(dir, "plan/objective.md"), params.objectiveMd);
            writeJson(path.join(dir, "plan/features.json"), missionFeatureList(mission).length > 0 ? missionFeatureList(mission) : params.featuresJson);
            const normalizedValidationContractJson = normalizeValidationContractJson(params.validationContractJson);
            writeJson(path.join(dir, "plan/validation-contract.json"), normalizedValidationContractJson);
            fs.writeFileSync(path.join(dir, "plan/validation-contract.md"), params.validationContractMd);
            fs.writeFileSync(path.join(dir, "skills/worker/SKILL.md"), params.workerSkillMd);
            fs.writeFileSync(path.join(dir, "skills/validator-scrutiny/SKILL.md"), params.validatorScrutinySkillMd);
            if (params.validatorUserTestingSkillMd)
                fs.writeFileSync(path.join(dir, "skills/validator-user-testing/SKILL.md"), params.validatorUserTestingSkillMd);
            const autoResume = shouldAutoResumeAfterPlanRevision(ctx.cwd, existingMission, mission);
            appendEvent(dir, existingMission ? "interactive_plan_revised" : "interactive_plan_written", { title: mission.title, features: missionFeatureList(mission).length, status: mission.status, autoResume });
            updateWidget(ctx, mission);
            persistOrchestratorState(ctx.cwd, mission, {
                activeMissionId: missionId,
                activePlanningMissionId: mission.status === "planning" ? missionId : undefined,
                activeRunningMissionId: autoResume || mission.status === "running" || mission.status === "paused" ? missionId : undefined,
            });
            ensureOfficialOrchestratorSessionRecord(ctx, mission);
            let text = persistedPlanSummary(mission, dir, params.objectiveMd, normalizedValidationContractJson, Boolean(existingMission));
            if (autoResume) {
                ctx.ui.notify(`Recovery plan saved; auto-resuming mission ${missionId}.`, "info");
                appendEvent(dir, "mission_auto_resume_after_plan_revision", { missionId });
                activeRunningId = missionId;
                const result = executeRunnerCommand({ command: "resume", missionId, source: "plan_revision_auto_resume" }, ctx, pi, orchestratorState);
                text = `${text}\n\n${result.text}`;
            }
            return { content: [{ type: "text", text }], details: { missionId, dir, autoResumed: autoResume } };
        },
    });
    pi.on("before_agent_start", async (_event, ctx) => {
        const content = lightweightMissionContext(ctx.cwd, orchestratorState);
        if (!content)
            return;
        return {
            message: {
                customType: "missions-orchestrator-context",
                display: false,
                content,
            },
        };
    });
    const handleMissions = async (rawArgs, ctx) => {
        const [subcommand, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
        const args = rest.join(" ");
        try {
            if (!subcommand || subcommand === "new" || !["status", "run", "resume", "list", "clear", "models"].includes(subcommand)) {
                const goal = subcommand === "new" ? args : rawArgs.trim();
                await startMissionOrchestrator(goal, ctx, pi);
                return { ok: true, text: "Mission planning loaded." };
            }
            if (subcommand === "models") {
                const modelArgs = args.split(/\s+/).filter(Boolean);
                if (modelArgs[0] === "set")
                    modelArgs.shift();
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
                if (!id)
                    return { ok: false, text: "No mission found to run." };
                activeRunningId = id;
                const mission = loadMission(ctx.cwd, id);
                persistOrchestratorState(ctx.cwd, mission, { activeMissionId: id, activePlanningMissionId: undefined, activeRunningMissionId: id });
                ensureOfficialOrchestratorSessionRecord(ctx, mission);
                return executeRunnerCommand({ command: subcommand === "resume" ? "resume" : "start", missionId: id, source: `missions_${subcommand}_command` }, ctx, pi, orchestratorState);
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
            const usage = "Usage: /missions [goal] | /missions new [goal] | /missions run|resume [id] | /missions status [id] | /missions list | /missions clear | /missions models [set] [role] [model]";
            ctx.ui.notify(usage, "warning");
            return { ok: false, text: usage };
        }
        catch (error) {
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
            if (!mission)
                return { content: [{ type: "text", text: "No missions found." }], details: {}, isError: true };
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
            if (!ok)
                return { content: [{ type: "text", text: "Mission clear canceled by user." }], details: { clearedIds: [] } };
            try {
                const result = clearCompletedMissions(ctx.cwd);
                ctx.ui.notify(result.text, result.clearedIds.length > 0 ? "info" : "warning");
                updateWidget(ctx, activeMissionFromState(ctx.cwd, orchestratorState) ?? latestVisibleMission(ctx.cwd));
                return { content: [{ type: "text", text: result.text }], details: result };
            }
            catch (error) {
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
        description: "Open read-only Mission Control overview and detail overlay",
        handler: async (args, ctx) => {
            const targetMissionId = args.trim() || undefined;
            await openMissionControl(ctx, orchestratorState, targetMissionId, pi);
        },
    });
    pi.registerCommand("mission-orchestrator", {
        description: "Open a dedicated orchestrator chat session for a running/active mission",
        handler: async (args, ctx) => {
            const mission = resolveMission(ctx.cwd, args.trim() || undefined, orchestratorState);
            if (!mission) {
                ctx.ui.notify("No mission found for orchestrator session.", "warning");
                return;
            }
            await openOrSwitchMissionOrchestratorSession(ctx, mission);
        },
    });
    pi.registerCommand("mission", {
        description: "Alias for /missions",
        handler: async (args, ctx) => { await handleMissions(args, ctx); },
    });
    pi.on("session_start", async (_event, ctx) => {
        orchestratorState = latestOrchestratorStateFromSession(ctx.cwd, ctx.sessionManager.getEntries());
        const active = activeMissionFromState(ctx.cwd, orchestratorState);
        if (!orchestratorState && active)
            orchestratorState = buildOrchestratorState(ctx.cwd, active);
        activeMissionId = active?.id ?? orchestratorState?.activeMissionId;
        activePlanningId = active?.status === "planning" ? active.id : orchestratorState?.activePlanningMissionId;
        activeRunningId = active?.status === "running" || active?.status === "paused" ? active.id : orchestratorState?.activeRunningMissionId;
        if (active && (!orchestratorState?.context || orchestratorState.context.id !== active.id || orchestratorState.context.status !== active.status)) {
            persistOrchestratorState(ctx.cwd, active, { activeMissionId: active.id, activePlanningMissionId: activePlanningId, activeRunningMissionId: activeRunningId });
        }
        if (active)
            ensureOfficialOrchestratorSessionRecord(ctx, active);
        updateWidget(ctx, active ?? latestVisibleMission(ctx.cwd));
    });
}
