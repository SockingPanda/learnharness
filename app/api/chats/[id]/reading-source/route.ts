import { getReadingSourceDownload } from "@/src/server";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	return getReadingSourceDownload((await ctx.params).id);
}
