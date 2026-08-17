import { NextResponse } from "next/server";
import { fetchExperimentResultsSummary } from "@/lib/optimizely";
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
    return NextResponse.json({ error: "Missing Optimizely API token" }, { status: 401 });
  }

  const experimentId = String(body.experimentId ?? "").trim();
  if (!experimentId) {
    return NextResponse.json({ error: "experimentId is required" }, { status: 400 });
  }

  const summary = await fetchExperimentResultsSummary(token, experimentId);
  if ("error" in summary) {
    return NextResponse.json({ error: summary.error }, { status: summary.status ?? 502 });
  }

  return NextResponse.json(summary);
}
