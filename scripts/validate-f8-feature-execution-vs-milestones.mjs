import fs from "node:fs";
import ts from "typescript";

const file = new URL("../extensions/missions/index.ts", import.meta.url);
const source = fs.readFileSync(file, "utf8");
const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

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

function callName(call) {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return undefined;
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

const findAwaitingFn = findFunction("findFeatureAwaitingValidation");
if (!findAwaitingFn) fail("missing findFeatureAwaitingValidation function");
const awaitingText = findAwaitingFn.getText(sf);
if (!awaitingText.includes("for (const feature of missionFeatureList(mission))")) fail("findFeatureAwaitingValidation must scan features sequentially.");
if (!awaitingText.includes("if (featureAwaitingValidation(mission, feature))")) fail("findFeatureAwaitingValidation must detect feature-level awaiting validation.");
if (!awaitingText.includes("return undefined;")) fail("findFeatureAwaitingValidation must gate later features when an earlier one is incomplete.");

const runnerClass = findFunction("MissionExecutionRunner");
if (!runnerClass || !ts.isClassDeclaration(runnerClass)) fail("missing MissionExecutionRunner class");
const runMethod = runnerClass.members.find((m) => ts.isMethodDeclaration(m) && nameOf(m) === "run");
if (!runMethod || !ts.isMethodDeclaration(runMethod) || !runMethod.body) fail("missing MissionExecutionRunner.run method");
const runText = runMethod.getText(sf);

const awaitingIdx = runText.indexOf("const awaitingValidation = findFeatureAwaitingValidation(mission);");
const nextIdx = runText.indexOf("const next = findNextFeature(mission);");
if (awaitingIdx === -1 || nextIdx === -1 || awaitingIdx > nextIdx) fail("runner must check awaiting feature validation before selecting the next feature.");

const validatorCalls = collect(runMethod.body, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runValidator");
for (const call of validatorCalls) {
  if (call.arguments.length < 5) fail("runner validator calls must be feature-targeted (targetFeature argument required).");
}

const hasAwaitingTargetCall = runText.includes("runValidator(this.ctx, mission, awaitingValidation.milestone, this.childSignal, awaitingValidation.feature)");
if (!hasAwaitingTargetCall) fail("runner must immediately validate the specific awaiting feature.");

const hasPostWorkerTargetCall = runText.includes("runValidator(this.ctx, mission, milestone, this.childSignal, feature)");
if (!hasPostWorkerTargetCall) fail("runner must validate the same feature immediately after worker success.");

const hasMilestoneOnlyGate = runText.includes("runValidator(this.ctx, mission, milestone, this.childSignal);");
if (hasMilestoneOnlyGate) fail("milestone-only validation must not be the default execution gate in runner loop.");

console.log("F8 validation checks passed.");