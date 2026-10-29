import type { ChatRecord } from "../core/contracts.ts";
import { stores, storageMode } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { rememberTurnFailure, turnFailure } from "./turn-runs.ts";

export const INTERRUPTED_TURN_NOTICE = "The previous turn was interrupted. Retry explicitly to continue.";

/** A persisted receipt survives process loss; mounting a view cannot authorize replay. */
export function sessionTurnFailure(record: Pick<ChatRecord, "id" | "pendingTurnId">): string | undefined {
	return turnFailure(record.id) ?? (record.pendingTurnId && !isTurnRunning(record.id) ? INTERRUPTED_TURN_NOTICE : undefined);
}

export async function restoreInterruptedTurns(): Promise<void> {
	if (storageMode() !== "any") return;
	for (const summary of await stores.chatStore.listChats()) {
		const record = await stores.chatStore.getChat(summary.id);
		if (record?.pendingTurnId && !isTurnRunning(record.id)) rememberTurnFailure(record.id, INTERRUPTED_TURN_NOTICE);
	}
}
