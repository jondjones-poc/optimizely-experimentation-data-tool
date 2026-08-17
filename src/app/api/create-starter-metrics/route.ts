import { NextResponse } from "next/server";
import { createStarterCustomMetrics } from "@/lib/optimizely";
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
          "Missing Optimizely API token. Paste a Personal Access Token, set Authorization: Bearer, or configure OPTIMIZELY_API_TOKEN.",
      },
      { status: 401 },
    );
  }

  const projectId = String(body.projectId ?? "").trim();
  const experimentId = String(body.experimentId ?? "").trim();
  if (!projectId || !experimentId) {
    return NextResponse.json(
      { error: "projectId and experimentId are required" },
      { status: 400 },
    );
  }

  const result = await createStarterCustomMetrics(token, projectId, experimentId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 502 });
  }

  return NextResponse.json(result);
}
