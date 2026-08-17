import { NextResponse } from "next/server";
import {
  fetchExperimentDetails,
  fetchExperimentResultsSummary,
  fetchProjectAccountId,
} from "@/lib/optimizely";
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

  const acc = await fetchProjectAccountId(token, projectId);
  if ("error" in acc) {
    return NextResponse.json({ error: acc.error }, { status: acc.status ?? 502 });
  }

  const exp = await fetchExperimentDetails(token, experimentId);
  if ("error" in exp) {
    return NextResponse.json({ error: exp.error }, { status: exp.status ?? 502 });
  }

  const results = await fetchExperimentResultsSummary(token, experimentId);
  const experimentStartTime =
    results && !("error" in results) ? results.meta?.startTime : undefined;

  return NextResponse.json({
    accountId: acc.accountId,
    codeRevision: acc.codeRevision,
    variations: exp.variations,
    metrics: exp.metrics,
    ...(experimentStartTime ? { experimentStartTime } : {}),
  });
}
