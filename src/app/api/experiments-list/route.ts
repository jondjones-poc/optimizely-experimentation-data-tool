import { NextResponse } from "next/server";
import { fetchExperimentsForCampaign } from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = resolveOptimizelyToken(req, body);
  if (!token) {
    return NextResponse.json(
      {
        error:
          "Missing Optimizely API token. Paste a token, use Authorization: Bearer, or set OPTIMIZELY_API_TOKEN.",
      },
      { status: 401 },
    );
  }

  const campaignId = String(body.campaignId ?? "").trim();
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  const out = await fetchExperimentsForCampaign(token, campaignId);
  if ("error" in out) {
    return NextResponse.json({ error: out.error }, { status: out.status ?? 502 });
  }

  return NextResponse.json({ experiments: out.experiments });
}
