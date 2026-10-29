import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot, graphSessionIndex as sessionIndex, graphSessionPropositions as sessionPropositions, type GraphCalculationDeps } from "../core/graph.ts";
import { graphDraft } from "../core/storage-snapshot.ts";
import { withGraphWrite } from "../core/storage-coordination.ts";
import { deleteNodeTraces, type NodeDeletionStats } from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { callCost } from "./pricing.ts";

/** IO ends here; every domain calculation receives a detached snapshot. */
export async function loadGraphCalculationDeps(): Promise<GraphCalculationDeps> {
	const snapshot = await stores.graphStore.readSnapshot();
	const summaries = await stores.chatStore.listChats();
	const records = await Promise.all(summaries.map((summary) => stores.chatStore.getChat(summary.id)));
	const chats = new Map(records.flatMap((record) => record ? [[record.id, record] as const] : []));
	return {
		graphStore: graphDraft(snapshot).store,
		chatStore: { getChat: (id) => chats.get(id) ?? null, listChats: () => summaries },
	};
}

export function graphView(): Promise<GraphSnapshot> {
	return withGraphWrite(async () => graphSnapshot(await loadGraphCalculationDeps()));
}

export function graphSessionIndex() {
	return withGraphWrite(async () => sessionIndex(await loadGraphCalculationDeps()));
}

export function graphSessionPropositions(sessionId: string) {
	return withGraphWrite(async () => sessionPropositions(await loadGraphCalculationDeps(), sessionId));
}

export async function graphCosts(): Promise<GraphCostSummary> {
	const records = await Promise.all((await stores.chatStore.listChats()).map((summary) => stores.chatStore.getChat(summary.id)));
	const chats = records.flatMap((record) => record?.extractions?.length ? [{ title: record.title ?? record.id, extractions: record.extractions }] : []);
	const sources = (await stores.graphStore.readSources()).filter((source) => source.extractions?.length).map((source) => ({ filePath: source.filePath, extractions: source.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** Opaque adapter revision: clients compare equality, never clock order. */
export function graphRevision(): Promise<string> {
	return stores.graphStore.getRevision();
}

export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: string };

export function deleteGraphNode(nodeId: string): Promise<NodeDeleteOutcome> {
	return withGraphWrite(async () => {
		if (extractionStatuses().length > 0) return { ok: false, status: 409, code: "extraction_running", error: "An extraction is running — try again when it finishes" };
		const draft = graphDraft(await stores.graphStore.readSnapshot());
		const stats = deleteNodeTraces(draft.store, nodeId);
		if (stats === null) return { ok: false, status: 404, code: "not_found", error: "No such node" };
		await stores.graphStore.commitBatch(draft.batch(`delete-node:${crypto.randomUUID()}`));
		return { ok: true, stats, graphRevision: await graphRevision() };
	});
}
