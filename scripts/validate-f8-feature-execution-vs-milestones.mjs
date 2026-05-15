import fs from "node:fs";
import ts from "typescript";

const file = new URL("../extensions/missions/runtime-extension.ts", import.meta.url);
const source = fs.readFileSync(file, "utf8");
const sf = ts.createSourceFile("runtime-extension.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function fail(message) {
  throw new Error(message);
}

function nameOf(node) {
  if (!node?.name) return undefined;
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function findFunction(name) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && nameOf(stmt) === name) return stmt;
    if (ts.isClassDeclaration(stmt) && name === "MissionExecutionRunner") return stmt;
  }
  return undefined;
}

function collect(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (child) => collect(child, pred, out));
  return out;
}

const missionMilestonesFn = findFunction("missionMilestones");
if (!missionMilestonesFn) fail("missing missionMilestones function");
const missionMilestonesText = missionMilestonesFn.getText(sf);
if (!missionMilestonesText.includes("if (Array.isArray(mission.milestones) && mission.milestones.length > 0) return mission.milestones;")) {
  fail("missionMilestones must preserve/read mission.milestones metadata when present.");
}

const normalizeMissionShapeFn = findFunction("normalizeMissionShape");
if (!normalizeMissionShapeFn) fail("missing normalizeMissionShape function");
const normalizeText = normalizeMissionShapeFn.getText(sf);
if (normalizeText.includes("mission.milestones = undefined") || normalizeText.includes("mission.currentMilestoneId = undefined")) {
  fail("normalizeMissionShape must not clear milestone metadata by default.");
}

for (const helper of [
  "currentRunnableMilestone",
  "findNextFeatureInMilestone",
  "milestoneWorkersComplete",
  "milestoneAwaitingScrutinyValidation",
  "milestoneAwaitingUserTestingValidation",
]) {
  if (!findFunction(helper)) fail(`missing milestone run-loop helper: ${helper}`);
}

const findNextInMilestone = findFunction("findNextFeatureInMilestone").getText(sf);
if (!findNextInMilestone.includes("for (const feature of milestone.features)")) fail("findNextFeatureInMilestone must scan only the current milestone.");
if (!findNextInMilestone.includes("areFeatureDependenciesSatisfied(feature, statuses)")) fail("findNextFeatureInMilestone must preserve dependency gating.");

const runnerClass = findFunction("MissionExecutionRunner");
if (!runnerClass || !ts.isClassDeclaration(runnerClass)) fail("missing MissionExecutionRunner class");
const runMethod = runnerClass.members.find((m) => ts.isMethodDeclaration(m) && nameOf(m) === "run");
if (!runMethod || !ts.isMethodDeclaration(runMethod) || !runMethod.body) fail("missing MissionExecutionRunner.run method");
const runText = runMethod.getText(sf);

const workerIdx = runText.indexOf("const nextFeature = findNextFeatureInMilestone(mission, milestone);");
const scrutinyIdx = runText.indexOf("if (milestoneAwaitingScrutinyValidation(milestone))");
const userTestingIdx = runText.indexOf("if (milestoneAwaitingUserTestingValidation(milestone))");
if (workerIdx === -1 || scrutinyIdx === -1 || userTestingIdx === -1) fail("runner must sequence milestone workers, scrutiny validation, then user-testing validation.");
if (!(workerIdx < scrutinyIdx && scrutinyIdx < userTestingIdx)) fail("runner must run workers before milestone validators and scrutiny before user-testing.");

const milestoneValidatorCall = "runValidator(this.ctx, mission, milestone, this.childSignal)";
if (!runText.includes(milestoneValidatorCall)) fail("runner should have one default scrutiny validator call at milestone boundary.");
if ((runText.match(/runValidator\(/g) ?? []).length !== 1) fail("runner should have exactly one default scrutiny validator call.");

if (runText.includes("findFeatureAwaitingValidation(mission)") || runText.includes("findFeatureAwaitingUserTesting(mission)")) {
  fail("runner must not use per-feature validation gates by default.");
}
if (runText.includes("runValidator(this.ctx, mission, milestone, this.childSignal, feature)")) {
  fail("runner must not validate the same feature immediately after worker success.");
}
if (!runText.includes("runMilestoneUserTestingValidator(this.ctx, mission, milestone, this.childSignal)")) {
  fail("runner must use milestone user-testing validator mode when configured.");
}

console.log("F8 validation checks passed.");
