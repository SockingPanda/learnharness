import type { GraphCommit, GraphLedgerSnapshot, GraphLedgers, GraphStore, SyncStore } from "./ports.ts";

/** A detached, synchronous working copy. Domain algorithms never perform IO. */
export function graphDraft(input: GraphLedgerSnapshot) {
	const state = structuredClone(input);
	const append: Partial<GraphLedgers> = {};
	const replace: Partial<GraphLedgers> = {};
	let positionsChanged = false;
	function add<K extends keyof GraphLedgers>(key: K, row: GraphLedgers[K][number]) {
		(state[key] as GraphLedgers[K][number][]).push(row);
		if (replace[key]) replace[key] = state[key];
		else ((append[key] ??= []) as GraphLedgers[K][number][]).push(row);
	}
	const store: SyncStore<GraphStore> = {
		readSnapshot: () => structuredClone(state),
		getRevision: () => state.revision,
		commitBatch: () => { throw new Error("A graph draft cannot persist a batch"); },
		appendNode: (row) => add("nodes", row), readNodes: () => state.nodes,
		appendChain: (row) => add("chains", row), readChains: () => state.chains,
		appendCoverage: (row) => add("coverage", row), readCoverage: () => state.coverage,
		appendCheckpoint: (row) => add("checkpoints", row), readCheckpoints: () => state.checkpoints,
		readPositions: () => state.positions,
		writePositions: (positions) => { state.positions = positions; positionsChanged = true; },
		readSources: () => state.sources,
		upsertSource: (source) => {
			const index = state.sources.findIndex((row) => row.id === source.id);
			if (index < 0) state.sources.push(source); else state.sources[index] = source;
		},
		appendSourceUsage: (id, entry) => {
			const source = state.sources.find((row) => row.id === id);
			if (source && !source.extractions?.some((row) => row.startedAt === entry.startedAt)) (source.extractions ??= []).push(entry);
		},
		rewriteLedgers: (next) => {
			for (const key of ["nodes", "chains", "coverage", "checkpoints"] as const) {
				if (!next[key]) continue;
				Object.assign(state, { [key]: next[key] });
				Object.assign(replace, { [key]: next[key] });
				delete append[key];
			}
		},
	};
	return {
		store,
		batch(operationId: string): GraphCommit {
			return { operationId, append, replace, ...(positionsChanged ? { positions: state.positions } : {}) };
		},
	};
}
