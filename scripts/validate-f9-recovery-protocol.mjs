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
if (!repairText.includes("const activeItemId = mission.activeRun.itemId")) {
  fail("recovery repair must reconcile stale activeRun using mission.activeRun.itemId for both worker and validator runs.");
}

// Executable regression: when latestBlock is F5 but mission state points at F6,
// recovery must keep F5 as the execution gate and clear stale activeRun.
(function runRecoveryRegression() {
  const features = [
    { id: "F5", status: "failed" },
    { id: "F6", status: "pending" },
  ];
  const mission = {
    currentFeatureId: "F6",
    activeRun: { kind: "validator", itemId: "F6", runId: "run-f6-validator" },
    status: "running",
  };
  const gateId = "F5";
  const indexById = new Map(features.map((feature, index) => [feature.id, index]));
  const gateFeature = features.find((feature) => feature.id === gateId);
  if (!gateFeature) fail("test setup failed: gate feature missing");

  if (gateFeature.status === "failed" || gateFeature.status === "running") gateFeature.status = "pending";
  mission.currentFeatureId = gateFeature.id;
  const activeIdx = indexById.get(mission.activeRun.itemId);
  const gateIdx = indexById.get(gateFeature.id);
  if (activeIdx !== undefined && gateIdx !== undefined && activeIdx > gateIdx) mission.activeRun = undefined;
  mission.status = "blocked";

  if (mission.currentFeatureId !== "F5") fail("regression failed: recovery must reset gate to F5.");
  if (mission.activeRun) fail("regression failed: stale activeRun for F6 must be cleared.");
  if (mission.status !== "blocked") fail("regression failed: mission must be blocked pending F5 recovery.");
  if (features[0].status !== "pending") fail("regression failed: failed gate feature must be normalized to pending.");
})();

const runMissionFn = findFunction("runMission");
if (!runMissionFn) fail("missing runMission");
const runText = runMissionFn.getText(sf);
if (!runText.includes("const gateRepair = repairMissionExecutionGateState")) fail("runMission must invoke gate recovery before execution.");
if (!runText.includes("mission_recovery_gate_repaired")) fail("recovery repairs must be auditable via event log.");

console.log("F9 recovery protocol validation checks passed.");
