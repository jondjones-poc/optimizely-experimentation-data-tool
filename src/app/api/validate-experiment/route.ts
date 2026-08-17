import { NextResponse } from "next/server";
import { validateExperimentSetup, type MetricEventInfo, type MetricKind } from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

function parseKind(raw: unknown): MetricKind | null {
  const k = String(raw ?? "").trim().toLowerCase();
  if (k === "revenue" || k === "click" || k === "pageview" || k === "custom") return k;
  return null;
}

function parseExpectedMetrics(raw: unknown): MetricEventInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: MetricEventInfo[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const key = String(o.key ?? "").trim();
    const kind = parseKind(o.kind);
    const name = String(o.name ?? key).trim();
    if (!key || !kind) continue;
    if (kind === "revenue") {
      out.push({ key, kind, name: name || "Overall revenue" });
      continue;
    }
    const event_id = Number(o.event_id);
    if (!Number.isFinite(event_id)) continue;
    out.push({
      key,
      kind,
      name,
      event_id,
      event_type: typeof o.event_type === "string" ? o.event_type : undefined,
    });
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
    return NextResponse.json({ error: "Missing Optimizely API token" }, { status: 401 });
  }

  const experimentId = String(body.experimentId ?? "").trim();
  if (!experimentId) {
    return NextResponse.json({ error: "experimentId is required" }, { status: 400 });
  }

  const expectedMetrics = parseExpectedMetrics(body.metrics);
  const report = await validateExperimentSetup(token, experimentId, expectedMetrics);
  if ("error" in report) {
    return NextResponse.json({ error: report.error }, { status: report.status ?? 502 });
  }

  return NextResponse.json(report);
}
