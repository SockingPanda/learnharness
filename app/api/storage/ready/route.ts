import { storageReady } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	try {
		return Response.json(await storageReady(), { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ ready: false, error: "The local database is unavailable. Restart the application to reconnect." }, {
			status: 503, headers: { "Cache-Control": "no-store" },
		});
	}
}
