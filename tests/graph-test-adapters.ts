import { getGraph as deriveGraph, graphSnapshot as deriveSnapshot, mergeFindings as calculateMerge, type GraphDeps } from "../src/core/graph.ts";
import { deleteChatTraces as calculateChatDeletion, deleteNodeTraces as calculateNodeDeletion } from "../src/core/graph-deletion.ts";
import type { GraphStore, GraphMemoryStore, GraphCommit, GraphLedgerSnapshot } from "../src/core/ports.ts";
import { graphDraft } from "../src/core/storage-snapshot.ts";

export async function getGraph(store: GraphStore) { return deriveGraph(graphDraft(await store.readSnapshot()).store); }
export async function graphSnapshot(deps: GraphDeps) {
	const summaries = await deps.chatStore.listChats();
	const records = await Promise.all(summaries.map((summary) => deps.chatStore.getChat(summary.id)));
	return deriveSnapshot({ graphStore: graphDraft(await deps.graphStore.readSnapshot()).store, chatStore: { listChats: () => summaries, getChat: (id) => records.find((r) => r?.id === id) ?? null } });
}
export async function mergeFindings(sourceId: string, findings: Parameters<typeof calculateMerge>[1], verdicts: Parameters<typeof calculateMerge>[2], deps: GraphDeps, source: Parameters<typeof calculateMerge>[4]) {
	const draft = graphDraft(await deps.graphStore.readSnapshot());
	const stats = calculateMerge(sourceId, findings, verdicts, { graphStore: draft.store }, source);
	await deps.graphStore.commitBatch(draft.batch(crypto.randomUUID()));
	return stats;
}
export async function deleteChatTraces(store: GraphStore, id: string, mode: Parameters<typeof calculateChatDeletion>[2]) {
	const draft = graphDraft(await store.readSnapshot());
	const stats = calculateChatDeletion(draft.store, id, mode);
	await store.commitBatch(draft.batch(crypto.randomUUID()));
	return stats;
}
export async function deleteNodeTraces(store: GraphStore, id: string) {
	const draft = graphDraft(await store.readSnapshot());
	const stats = calculateNodeDeletion(draft.store, id);
	await store.commitBatch(draft.batch(crypto.randomUUID()));
	return stats;
}

/** Explicit promise facade for synchronous domain fixtures. */
export function asyncGraphStore(memory: GraphMemoryStore): GraphStore {
	const completed = new Set<string>();
	let revision = 0;
	const readSnapshot = async (): Promise<GraphLedgerSnapshot> => ({ nodes: memory.readNodes(), chains: memory.readChains(), coverage: memory.readCoverage(), checkpoints: memory.readCheckpoints(), positions: memory.readPositions(), sources: memory.readSources(), revision: String(revision) });
	const commitBatch = async (batch: GraphCommit) => {
		if (completed.has(batch.operationId)) return;
		const before = await readSnapshot();
		try {
		if (batch.replace) memory.rewriteLedgers(batch.replace);
		for (const node of batch.append?.nodes ?? []) memory.appendNode(node);
		for (const chain of batch.append?.chains ?? []) memory.appendChain(chain);
		for (const row of batch.append?.coverage ?? []) memory.appendCoverage(row);
		for (const row of batch.append?.checkpoints ?? []) memory.appendCheckpoint(row);
		if (batch.positions) memory.writePositions(batch.positions);
		completed.add(batch.operationId); revision++;
		} catch (error) {
			memory.rewriteLedgers(before);
			try { memory.writePositions(before.positions); } catch { /* injected layout seam may keep failing */ }
			throw error;
		}
	};
	return {
		readSnapshot, commitBatch, getRevision: async () => String(revision),
		appendNode: async (row) => memory.appendNode(row), readNodes: async () => memory.readNodes(),
		appendChain: async (row) => memory.appendChain(row), readChains: async () => memory.readChains(),
		appendCoverage: async (row) => memory.appendCoverage(row), readCoverage: async () => memory.readCoverage(),
		appendCheckpoint: async (row) => memory.appendCheckpoint(row), readCheckpoints: async () => memory.readCheckpoints(),
		readPositions: async () => memory.readPositions(), writePositions: async (rows) => memory.writePositions(rows),
		readSources: async () => memory.readSources(), upsertSource: async (row) => memory.upsertSource(row),
		appendSourceUsage: async (id, row) => memory.appendSourceUsage(id, row), rewriteLedgers: async (rows) => memory.rewriteLedgers(rows),
	};
}
