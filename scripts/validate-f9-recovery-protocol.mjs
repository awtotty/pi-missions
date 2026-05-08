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
  return sf.statements.find((stmt) => ts.isFunctionDeclaration(stmt) && nameOf(stmt) === name);
}

const findNextFeatureFn = findFunction("findNextFeature");
if (!findNextFeatureFn) fail("missing findNextFeature");
const nextText = findNextFeatureFn.getText(sf);
if (!nextText.includes("if (feature.status === \"complete\" || feature.status === \"skipped\") continue;")) fail("findNextFeature must skip only complete/skipped features.");
if (!nextText.includes("return feature.status === \"pending\" ?")) fail("findNextFeature must gate execution to the first incomplete feature only.");

const repairFn = findFunction("repairMissionExecutionGateState");
if (!repairFn) fail("missing repairMissionExecutionGateState");
const repairText = repairFn.getText(sf);
for (const token of ["latestBlockFromArtifacts", "normalizeBlockedFeatureForRetry", "clearActiveRunOwnership", "mission.status = \"blocked\""]) {
  if (!repairText.includes(token)) fail(`recovery repair must include ${token}`);
}

const runMissionFn = findFunction("runMission");
if (!runMissionFn) fail("missing runMission");
const runText = runMissionFn.getText(sf);
if (!runText.includes("const gateRepair = repairMissionExecutionGateState")) fail("runMission must invoke gate recovery before execution.");
if (!runText.includes("mission_recovery_gate_repaired")) fail("recovery repairs must be auditable via event log.");

console.log("F9 recovery protocol validation checks passed.");
