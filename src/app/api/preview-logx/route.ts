import { NextResponse } from "next/server";
import { buildPreviewVisitor, dollarsToRevenueCents } from "@/lib/logx";
import type { MetricEventInfo, MetricKind } from "@/lib/optimizely";

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

function parseMetric(raw: unknown): MetricEventInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
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
    return { key, kind, name: name || "Overall revenue", ...rateFields };
  }

  const event_id = Number(o.event_id);
  if (!Number.isFinite(event_id)) return null;
  const event_type = typeof o.event_type === "string" ? o.event_type.trim() : "";
  return {
    key,
    kind,
    name,
    event_id,
    ...(event_type ? { event_type } : {}),
    ...rateFields,
    ...(logxProperties ? { logxProperties } : {}),
  };
}

/** Return one sample logx visitor payload for a single metric (no POST to Optimizely). */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const campaignId = String(body.campaignId ?? "").trim();
  const projectId = String(body.projectId ?? "").trim();
  const experimentId = String(body.experimentId ?? "").trim();
  const variations = Array.isArray(body.variations) ? body.variations : [];
  const metric = parseMetric(body.metric);
  const companionConversion = parseMetric(body.companionConversion);

  if (!campaignId || !projectId || !experimentId || variations.length === 0 || !metric) {
    return NextResponse.json(
      { error: "campaignId, projectId, experimentId, variations, and metric are required" },
      { status: 400 },
    );
  }

  const revenueDollars = Math.max(0, Number(body.revenuePerConversionDollars) || 0);
  const visitor = buildPreviewVisitor({
    campaignId,
    projectId,
    experimentId,
    variations: variations as { variation_id: string; name: string }[],
    metric,
    revenuePerConversionCents: dollarsToRevenueCents(revenueDollars),
    companionConversion: companionConversion ?? undefined,
    personalizationCampaign: body.personalizationCampaign === true,
    trafficMode: body.trafficMode === "all_treatment" ? "all_treatment" : "balanced",
  });

  const batch = {
    account_id: String(body.accountId ?? "").trim() || undefined,
    project_id: projectId,
    ...(body.codeRevision ? { revision: String(body.codeRevision) } : {}),
    anonymize_ip: true,
    enrich_decisions: true,
    client_name: "optimizely-experiment-data/web",
    client_version: "1.0.0",
    visitors: [visitor],
  };

  return NextResponse.json({
    visitor,
    batch,
    note:
      metric.kind === "revenue" && companionConversion
        ? "Revenue preview includes a sample conversion event — trackRevenue only fires when a conversion exists in the same snapshot."
        : metric.kind === "revenue"
          ? "Revenue-only preview — trackRevenue fires directly (no conversion metrics checked)."
          : "Conversion event always included for preview (not subject to random rates).",
  });
}
