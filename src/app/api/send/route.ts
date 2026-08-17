import { NextResponse } from "next/server";
import {
  buildVisitor,
  dollarsToRevenueCents,
  normalizeVisitorTimestampRange,
  postLogxBatch,
  spreadVisitorTimestampMs,
} from "@/lib/logx";
import type { MetricEventInfo, MetricKind, VariationInfo } from "@/lib/optimizely";

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

function parseKind(raw: unknown): MetricKind | null {
  const k = String(raw ?? "").trim().toLowerCase();
  if (k === "revenue" || k === "click" || k === "pageview" || k === "custom") return k;
  return null;
}

function parseProperties(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseMetrics(raw: unknown): MetricEventInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MetricEventInfo[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const o = m as Record<string, unknown>;
    const key = String(o.key ?? "").trim();
    const kind = parseKind(o.kind);
    const name = String(o.name ?? key).trim();
    if (!key || !kind) return null;
    const ctrlRaw = Number(o.controlConversionRate);
    const treatRaw = Number(o.treatmentConversionRate);
    const rateFields = {
      ...(Number.isFinite(ctrlRaw) ? { controlConversionRate: Math.min(1, Math.max(0, ctrlRaw)) } : {}),
      ...(Number.isFinite(treatRaw) ? { treatmentConversionRate: Math.min(1, Math.max(0, treatRaw)) } : {}),
    };
    const logxProperties = parseProperties(o.logxProperties);
    if (kind === "revenue") {
      out.push({
        key,
        kind,
        name: name || "Overall revenue",
        ...rateFields,
      });
      continue;
    }
    const event_id = Number(o.event_id);
    if (!Number.isFinite(event_id)) return null;
    const event_type = typeof o.event_type === "string" ? o.event_type.trim() : "";
    out.push({
      key,
      kind,
      name,
      event_id,
      ...(event_type ? { event_type } : {}),
      ...rateFields,
      ...(logxProperties ? { logxProperties } : {}),
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
  const metricsToFireSafe = metricsToFire ?? [];

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

  const controlRaw = Number(body.controlConversionRate);
  const treatmentRaw = Number(body.treatmentConversionRate);
  const controlConversionRate = Number.isFinite(controlRaw)
    ? Math.min(1, Math.max(0, controlRaw))
    : 0.2;
  const treatmentConversionRate = Number.isFinite(treatmentRaw)
    ? Math.min(1, Math.max(0, treatmentRaw))
    : 0.85;

  const codeRevision = String(body.codeRevision ?? "").trim() || undefined;
  const personalizationCampaign = body.personalizationCampaign === true;
  const trafficMode = body.trafficMode === "all_treatment" ? "all_treatment" : "balanced";

  const revenueDollarsRaw = Number(body.revenuePerConversionDollars);
  const revenuePerConversionCents = dollarsToRevenueCents(
    Number.isFinite(revenueDollarsRaw) ? revenueDollarsRaw : 100_000,
  );

  const totalVisitorCountRaw = Number(body.totalVisitorCount);
  const totalVisitorCount = Number.isFinite(totalVisitorCountRaw)
    ? Math.max(1, Math.floor(totalVisitorCountRaw))
    : count;
  const visitorIndexOffsetRaw = Number(body.visitorIndexOffset);
  const visitorIndexOffset = Number.isFinite(visitorIndexOffsetRaw)
    ? Math.max(0, Math.floor(visitorIndexOffsetRaw))
    : 0;

  const endMsRaw = Number(body.timestampEndMs);
  const startMsRaw = Number(body.timestampStartMs);
  const { startMs, endMs } = normalizeVisitorTimestampRange(
    Number.isFinite(startMsRaw) ? startMsRaw : Date.now() - 30 * 24 * 60 * 60 * 1000,
    Number.isFinite(endMsRaw) ? endMsRaw : Date.now(),
  );

  const visitors = Array.from({ length: count }, (_, i) => {
    const globalIndex = visitorIndexOffset + i;
    const eventTimestampMs = spreadVisitorTimestampMs(
      globalIndex,
      totalVisitorCount,
      startMs,
      endMs,
    );
    return buildVisitor({
      campaignId,
      projectId,
      experimentId,
      variations,
      metricsToFire: metricsToFireSafe,
      controlConversionRate,
      treatmentConversionRate,
      revenuePerConversionCents,
      eventTimestampMs,
      personalizationCampaign,
      trafficMode,
    });
  });

  const posted = await postLogxBatch({ accountId, projectId, codeRevision, visitors });
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
