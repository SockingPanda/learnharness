import { shutdownStorageRuntime } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
	try {
		await shutdownStorageRuntime();
		return Response.json({ stopped: true }, { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ stopped: false, error: "The database could not finish saving before shutdown." }, {
			status: 503, headers: { "Cache-Control": "no-store" },
		});
	}
}
