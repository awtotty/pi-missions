export type RecoveryFeatureStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export interface RecoveryGateInput {
	featureOrder: string[];
	featureStatusById: Record<string, RecoveryFeatureStatus>;
	blockedFeatureId?: string;
	currentFeatureId?: string;
	activeRunItemId?: string;
	missionStatus: string;
}

export interface RecoveryGatePlan {
	gateFeatureId?: string;
	normalizeGateToPending: boolean;
	setCurrentFeatureToGate: boolean;
	clearActiveRun: boolean;
	forceBlockedStatus: boolean;
}

export function computeRecoveryGatePlan(input: RecoveryGateInput): RecoveryGatePlan {
	const indexById = new Map(input.featureOrder.map((id, index) => [id, index]));
	const firstIncomplete = input.featureOrder.find((id) => {
		const status = input.featureStatusById[id];
		return status !== "complete" && status !== "skipped";
	});
	const blockedIncomplete = input.blockedFeatureId
		&& indexById.has(input.blockedFeatureId)
		&& input.featureStatusById[input.blockedFeatureId] !== "complete"
		&& input.featureStatusById[input.blockedFeatureId] !== "skipped"
		? input.blockedFeatureId
		: undefined;
	const gateFeatureId = blockedIncomplete ?? firstIncomplete;
	if (!gateFeatureId) {
		return {
			gateFeatureId: undefined,
			normalizeGateToPending: false,
			setCurrentFeatureToGate: false,
			clearActiveRun: false,
			forceBlockedStatus: false,
		};
	}
	const gateStatus = input.featureStatusById[gateFeatureId];
	const gateIdx = indexById.get(gateFeatureId);
	const currentIdx = input.currentFeatureId ? indexById.get(input.currentFeatureId) : undefined;
	const activeIdx = input.activeRunItemId ? indexById.get(input.activeRunItemId) : undefined;
	return {
		gateFeatureId,
		normalizeGateToPending: gateStatus === "failed" || gateStatus === "running",
		setCurrentFeatureToGate: input.currentFeatureId !== gateFeatureId && (currentIdx === undefined || (gateIdx !== undefined && currentIdx > gateIdx) || input.blockedFeatureId === gateFeatureId),
		clearActiveRun: activeIdx !== undefined && gateIdx !== undefined && activeIdx > gateIdx,
		forceBlockedStatus: input.missionStatus === "running" || input.missionStatus === "paused",
	};
}
