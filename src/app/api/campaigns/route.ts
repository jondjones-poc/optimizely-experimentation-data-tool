import { NextResponse } from "next/server";
import { discoverProjectCampaigns } from "@/lib/optimizely";
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

  const projectId = String(body.projectId ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const out = await discoverProjectCampaigns(token, projectId);
  if ("error" in out) {
    return NextResponse.json({ error: out.error }, { status: out.status ?? 502 });
  }

  return NextResponse.json({
    campaigns: out.campaigns,
    projectExperiments: out.projectExperiments,
    mode: out.mode,
  });
}
