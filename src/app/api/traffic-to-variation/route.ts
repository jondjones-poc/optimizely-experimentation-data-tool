import { NextResponse } from "next/server";
import type { TrafficMode } from "@/lib/form-persistence";
import { setExperimentTrafficAllocation } from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

function parseVariations(raw: unknown): { variation_id: string; name: string }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { variation_id: string; name: string }[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const variation_id = String(o.variation_id ?? "").trim();
    const name = String(o.name ?? variation_id).trim();
    if (!variation_id) return null;
    out.push({ variation_id, name });
  }
  return out;
}

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

  const experimentId = String(body.experimentId ?? "").trim();
  const variations = parseVariations(body.variations);
  const mode: TrafficMode = body.mode === "balanced" ? "balanced" : "all_treatment";

  if (!experimentId) {
    return NextResponse.json({ error: "experimentId is required" }, { status: 400 });
  }
  if (!variations?.length) {
    return NextResponse.json({ error: "variations must be a non-empty array" }, { status: 400 });
  }

  const result = await setExperimentTrafficAllocation(token, experimentId, mode, variations);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 502 });
  }

  const summary =
    result.mode === "all_treatment"
      ? `100% traffic → ${result.treatmentName}; all other variations 0%.`
      : `Balanced traffic: ${result.weights.map((w) => `${w.name} ${(w.weight / 100).toFixed(1)}%`).join(", ")}.`;

  return NextResponse.json({
    mode: result.mode,
    weights: result.weights,
    treatmentName: result.treatmentName,
    summary,
  });
}
