import fs from "node:fs";
import path from "node:path";

const file = path.resolve("extensions/missions/index.ts");
const source = fs.readFileSync(file, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!source.includes("mission.milestones = undefined"), "normalizeMissionShape must preserve mission.milestones metadata.");
assert(!source.includes("mission.currentMilestoneId = undefined"), "normalizeMissionShape must not clear currentMilestoneId by default.");
assert(source.includes("for (const feature of missionFeatureList(mission))"), "Feature execution/validation traversal must be feature-sequential.");
assert(source.includes("if (Array.isArray(mission.milestones) && mission.milestones.length > 0) return mission.milestones;"), "Milestones should remain readable grouping metadata when present.");
assert(source.includes("const awaitingValidation = findFeatureAwaitingValidation(mission);"), "Runner must check for a feature awaiting validation before starting later features.");
assert(source.includes("runValidator(this.ctx, mission, awaitingValidation.milestone, this.childSignal, awaitingValidation.feature)"), "Awaiting feature validation must target that feature immediately.");
assert(source.includes("runValidator(this.ctx, mission, milestone, this.childSignal, feature)"), "Post-worker validation must target the same feature attempt, not milestone-only gating.");
assert(!source.includes("runValidator(this.ctx, mission, milestone, this.childSignal);"), "Milestone-only validation must not be the default execution gate in runner loop.");

console.log("F8 validation checks passed.");
