import type { GraphCalculationDeps, GraphDeps } from "../core/graph.ts";
import { getGraph } from "../core/graph.ts";
import { graphDraft } from "../core/storage-snapshot.ts";
import { withGraphWrite } from "../core/storage-coordination.ts";
import type { GraphStore } from "../core/ports.ts";

export function readDerivedGraph(store: GraphStore) {
	return withGraphWrite(async () => getGraph(graphDraft(await store.readSnapshot()).store));
}

export function readGraphCalculationDeps(deps: GraphDeps): Promise<GraphCalculationDeps> {
	return withGraphWrite(async () => {
		const snapshot = await deps.graphStore.readSnapshot();
		const summaries = await deps.chatStore.listChats();
		const records = await Promise.all(summaries.map((summary) => deps.chatStore.getChat(summary.id)));
		const chats = new Map(records.flatMap((record) => record ? [[record.id, record] as const] : []));
		return {
			graphStore: graphDraft(snapshot).store,
			chatStore: { getChat: (id) => chats.get(id) ?? null, listChats: () => summaries },
		};
	});
}
