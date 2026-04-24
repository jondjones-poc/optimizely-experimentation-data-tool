import { NextResponse } from "next/server";
import { buildVisitor, postLogxBatch } from "@/lib/logx";
import type { MetricEventInfo, VariationInfo } from "@/lib/optimizely";

const MAX_BATCH = 1000;

function parseVariations(raw: unknown): VariationInfo[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: VariationInfo[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const variation_id = String(o.variation_id ?? "").trim();
    const name = String(o.name ?? variation_id);
    if (!variation_id) return null;
    out.push({ variation_id, name });
  }
  return out;
}

function parseMetrics(raw: unknown): MetricEventInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MetricEventInfo[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const o = m as Record<string, unknown>;
    const event_id = Number(o.event_id);
    const key = String(o.key ?? "").trim();
    if (!Number.isFinite(event_id) || !key) return null;
    out.push({ event_id, key });
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

  const accountId = String(body.accountId ?? "").trim();
  const projectId = String(body.projectId ?? "").trim();
  const campaignId = String(body.campaignId ?? "").trim();
  const experimentId = String(body.experimentId ?? "").trim();
  const variations = parseVariations(body.variations);
  const metricsToFire = parseMetrics(body.metricsToFire);

  if (!accountId || !projectId || !campaignId || !experimentId) {
    return NextResponse.json(
      { error: "accountId, projectId, campaignId, and experimentId are required" },
      { status: 400 },
    );
  }
  if (!variations?.length) {
    return NextResponse.json({ error: "variations must be a non-empty array" }, { status: 400 });
  }
  if (!metricsToFire?.length) {
    return NextResponse.json(
      { error: "Select at least one metric event (metricsToFire)" },
      { status: 400 },
    );
  }

  const countRaw = Number(body.count);
  const count = Number.isFinite(countRaw)
    ? Math.min(Math.max(1, Math.floor(countRaw)), MAX_BATCH)
    : 0;
  if (!count) {
    return NextResponse.json(
      { error: `count must be 1–${MAX_BATCH} (send multiple requests for larger runs)` },
      { status: 400 },
    );
  }

  const pRaw = Number(body.conversionProbability);
  const conversionProbability = Number.isFinite(pRaw)
    ? Math.min(1, Math.max(0, pRaw))
    : 0.35;

  const nowMs = Date.now();
  const visitors = Array.from({ length: count }, (_, i) =>
    buildVisitor({
      campaignId,
      experimentId,
      variations,
      metricsToFire,
      conversionProbability,
      nowMs,
      timeOffsetMs: i,
    }),
  );

  const posted = await postLogxBatch({ accountId, projectId, visitors });
  if (!posted.ok) {
    return NextResponse.json(
      { error: "logx request failed", status: posted.status, detail: posted.body },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    sent: count,
    logxStatus: posted.status,
  });
}
