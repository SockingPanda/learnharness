/**
 * One-time backfill: wipe the legacy ledgers and re-extract every chat with
 * the redesigned pipeline (vision §1, commit b07c907). Run from the master
 * tree only — data never crosses trees:
 *
 *   npx tsx --env-file=.env.local scripts/backfill-graph.ts
 */
import { stores, closeStorage, effectiveSettings } from "../src/server/stores.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { readDerivedGraph } from "../src/agent/graph-storage.ts";

const { chatStore, graphStore } = stores;

async function main() {
	const only = process.argv[2]; // optional: extract just one chat id
	const summaries = await chatStore.listChats();
	const chats = only ? summaries.filter((c) => c.id === only) : summaries;
	console.log(`[backfill] ${chats.length} chats to extract`);
	const pipeline = createExtractionPipeline({
		chatStore,
		graphStore,
		// Live budget: the graph section's setting, same as the app's trigger
		getChunkTokens: () => effectiveSettings().graph.extractionChunkTokens,
	});
	for (const chat of chats) {
		const t0 = Date.now();
		try {
			const stats = await pipeline.runExtraction(chat.id);
			console.log(
				`[backfill] ${chat.id} (${chat.title.slice(0, 40)}): ` +
					`${stats.nodes} nodes, ${stats.chains ?? 0} chains in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
		} catch (err) {
			console.error(`[backfill] ${chat.id} FAILED:`, err);
		}
	}
	const graph = await readDerivedGraph(graphStore);
	console.log(
		`[backfill] done: ${graph.nodes.length} nodes, ${graph.chains.length} chains`,
	);
}

main().finally(closeStorage);
