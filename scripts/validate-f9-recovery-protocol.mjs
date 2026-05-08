import fs from "node:fs";
import ts from "typescript";

async function loadRecoveryGateModule() {
  const gateFile = new URL("../extensions/missions/recovery-gate.ts", import.meta.url);
  const gateSource = fs.readFileSync(gateFile, "utf8");
  const transpiled = ts.transpileModule(gateSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: "recovery-gate.ts",
  }).outputText;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
  return import(dataUrl);
}

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

// Executable regression: use production helper logic for gate repair planning.
const { computeRecoveryGatePlan } = await loadRecoveryGateModule();
(function runRecoveryRegression() {
  const plan = computeRecoveryGatePlan({
    featureOrder: ["F5", "F6"],
    featureStatusById: { F5: "failed", F6: "pending" },
    blockedFeatureId: "F5",
    currentFeatureId: "F6",
    activeRunItemId: "F6",
    missionStatus: "running",
  });

  if (plan.gateFeatureId !== "F5") fail("regression failed: recovery must keep F5 as the execution gate.");
  if (!plan.normalizeGateToPending) fail("regression failed: failed gate feature must normalize to pending.");
  if (!plan.setCurrentFeatureToGate) fail("regression failed: currentFeatureId must be reset to F5.");
  if (!plan.clearActiveRun) fail("regression failed: stale activeRun for F6 must be cleared.");
  if (!plan.forceBlockedStatus) fail("regression failed: mission must be blocked pending F5 recovery.");
})();

const runMissionFn = findFunction("runMission");
if (!runMissionFn) fail("missing runMission");
const runText = runMissionFn.getText(sf);
if (!runText.includes("const gateRepair = repairMissionExecutionGateState")) fail("runMission must invoke gate recovery before execution.");
if (!runText.includes("mission_recovery_gate_repaired")) fail("recovery repairs must be auditable via event log.");

console.log("F9 recovery protocol validation checks passed.");
