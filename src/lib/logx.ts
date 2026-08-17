import { randomUUID } from "crypto";
import { applyInsecureTlsIfConfigured } from "@/lib/dev-tls";
import { logxEventShape } from "@/lib/logx-event-shape";
import { pickSimulationVariation, type TrafficMode, type VariationInfo } from "@/lib/variation-arms";
import type { MetricEventInfo } from "./optimizely";

export { pickSimulationVariation, resolveControlTreatment } from "@/lib/variation-arms";
export type { ControlTreatmentPair, TrafficMode, VariationInfo } from "@/lib/variation-arms";

function clampRate(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Logx / Web: revenue amounts are integer cents ($100 → 10000). */
export function dollarsToRevenueCents(dollars: number): number {
  return Math.round(Math.max(0, dollars) * 100);
}

/** Spread visitor event times evenly from experiment start through end (usually now). */
export function spreadVisitorTimestampMs(
  visitorIndex: number,
  totalVisitorCount: number,
  startMs: number,
  endMs: number,
): number {
  const safeTotal = Math.max(1, Math.floor(totalVisitorCount));
  const safeIndex = Math.min(Math.max(0, Math.floor(visitorIndex)), safeTotal - 1);
  const span = Math.max(0, endMs - startMs);
  if (span === 0 || safeTotal === 1) return endMs;
  const fraction = safeIndex / (safeTotal - 1);
  return Math.round(startMs + span * fraction);
}

export function normalizeVisitorTimestampRange(
  startMs: number,
  endMs: number,
): { startMs: number; endMs: number } {
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  let start = Number.isFinite(startMs) ? startMs : end - 30 * 24 * 60 * 60 * 1000;
  if (start >= end) start = end - 60 * 60 * 1000;
  return { startMs: start, endMs: end };
}

/** Matches Optimizely Web snippet `eventName` for overall revenue (see revenue tracking docs). */
export const WEB_REVENUE_EVENT_KEY = "trackRevenue";

function applyRevenueFields(event: Record<string, unknown>, revenueCents: number): void {
  const cents = Math.round(revenueCents);
  if (cents <= 0) return;
  event.revenue = cents;
  const existing =
    event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)
      ? (event.tags as Record<string, unknown>)
      : {};
  event.tags = { ...existing, revenue: cents };
}

/** Web overall revenue: separate event with `tags.revenue`, not only campaign_activated. */
function buildWebRevenueEvent(
  projectId: string,
  timestamp: number,
  revenueCents: number,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    entity_id: String(projectId),
    uuid: randomUUID().toUpperCase(),
    key: WEB_REVENUE_EVENT_KEY,
    timestamp,
  };
  applyRevenueFields(event, revenueCents);
  return event;
}

export type LogxVisitor = {
  visitor_id: string;
  session_id: string;
  attributes: [];
  snapshots: Array<{
    decisions: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  }>;
};

function parseTagValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const n = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(n)) return n;
  return raw;
}

function buildEventTags(m: MetricEventInfo): Record<string, string | number | boolean> {
  const tags: Record<string, string | number | boolean> = {};
  if (m.logxProperties) {
    for (const [k, v] of Object.entries(m.logxProperties)) {
      tags[k] = parseTagValue(v);
    }
  }
  return tags;
}

function buildConversionEvent(m: MetricEventInfo, timestamp: number): Record<string, unknown> | null {
  const shape = logxEventShape(m);
  if (!shape.entity_id || !shape.key) return null;

  const base: Record<string, unknown> = {
    entity_id: shape.entity_id,
    key: shape.key,
    uuid: randomUUID().toUpperCase(),
    timestamp,
  };

  if (m.kind === "click" || m.kind === "custom") {
    const tags = buildEventTags(m);
    if (Object.keys(tags).length > 0) {
      base.tags = tags;
    }
  }

  return base;
}

export function buildVisitor(params: {
  campaignId: string;
  projectId: string;
  experimentId: string;
  variations: VariationInfo[];
  metricsToFire: MetricEventInfo[];
  controlConversionRate: number;
  treatmentConversionRate: number;
  revenuePerConversionCents: number;
  eventTimestampMs: number;
  personalizationCampaign?: boolean;
  trafficMode?: TrafficMode;
}): LogxVisitor {
  const {
    campaignId,
    projectId,
    experimentId,
    variations,
    metricsToFire,
    controlConversionRate,
    treatmentConversionRate,
    revenuePerConversionCents,
    eventTimestampMs,
    personalizationCampaign = false,
    trafficMode = "balanced",
  } = params;

  const { variation, onControl } = pickSimulationVariation(variations, trafficMode);
  const ts = eventTimestampMs;

  const wantsRevenue = metricsToFire.some((m) => m.kind === "revenue");
  const eventMetrics = metricsToFire.filter((m) => m.kind !== "revenue" && m.event_id != null);
  const revenueMetric = metricsToFire.find((m) => m.kind === "revenue");
  const revenueOnly = wantsRevenue && eventMetrics.length === 0;
  const revenueArmRate = clampRate(
    onControl
      ? (revenueMetric?.controlConversionRate ?? controlConversionRate)
      : (revenueMetric?.treatmentConversionRate ?? treatmentConversionRate),
  );

  const decision: Record<string, unknown> = {
    campaign_id: String(campaignId),
    experiment_id: String(experimentId),
    variation_id: String(variation.variation_id),
  };
  if (personalizationCampaign) {
    decision.is_campaign_holdback = false;
  }

  const activationEvent: Record<string, unknown> = {
    entity_id: String(campaignId),
    uuid: randomUUID().toUpperCase(),
    type: "campaign_activated",
    timestamp: ts,
  };

  const events: Array<Record<string, unknown>> = [activationEvent];

  if (revenueOnly && revenuePerConversionCents > 0 && Math.random() < revenueArmRate) {
    events.push(buildWebRevenueEvent(projectId, ts + 1, revenuePerConversionCents));
  }

  let conversionIndex = 0;
  let hadConversion = false;
  for (const m of eventMetrics) {
    const ctrl = m.controlConversionRate ?? controlConversionRate;
    const treat = m.treatmentConversionRate ?? treatmentConversionRate;
    const metricRate = clampRate(onControl ? ctrl : treat);
    if (Math.random() < metricRate) {
      const conv = buildConversionEvent(m, ts + 2 + conversionIndex);
      if (conv) {
        events.push(conv);
        conversionIndex += 1;
        hadConversion = true;
      }
    }
  }

  // Overall revenue: separate trackRevenue event (never merge onto custom/pageview — that broke unique counts).
  if (wantsRevenue && !revenueOnly && revenuePerConversionCents > 0 && hadConversion) {
    events.push(
      buildWebRevenueEvent(projectId, ts + 2 + conversionIndex, revenuePerConversionCents),
    );
  }

  return {
    visitor_id: `visitor_${randomUUID().replace(/-/g, "")}`,
    session_id: `session_${randomUUID().replace(/-/g, "")}`,
    attributes: [],
    snapshots: [
      {
        decisions: [decision],
        events,
      },
    ],
  };
}

/** Deterministic sample visitor for one metric (always includes that metric's event). */
export function buildPreviewVisitor(params: {
  campaignId: string;
  projectId: string;
  experimentId: string;
  variations: VariationInfo[];
  metric: MetricEventInfo;
  revenuePerConversionCents?: number;
  /** When previewing revenue alongside conversions, show a sample conversion event too. */
  companionConversion?: MetricEventInfo;
  personalizationCampaign?: boolean;
  trafficMode?: TrafficMode;
  nowMs?: number;
}): LogxVisitor {
  const {
    campaignId,
    projectId,
    experimentId,
    variations,
    metric,
    revenuePerConversionCents = 0,
    companionConversion,
    personalizationCampaign = false,
    trafficMode = "balanced",
    nowMs = Date.now(),
  } = params;

  const { variation } = pickSimulationVariation(variations, trafficMode);
  const ts = nowMs;

  const decision: Record<string, unknown> = {
    campaign_id: String(campaignId),
    experiment_id: String(experimentId),
    variation_id: String(variation.variation_id),
  };
  if (personalizationCampaign) {
    decision.is_campaign_holdback = false;
  }

  const events: Array<Record<string, unknown>> = [
    {
      entity_id: String(campaignId),
      uuid: randomUUID().toUpperCase(),
      type: "campaign_activated",
      timestamp: ts,
    },
  ];

  let eventIndex = 1;
  if (metric.kind === "revenue") {
    const revenueOnly = !companionConversion;
    if (companionConversion) {
      const conv = buildConversionEvent(companionConversion, ts + eventIndex);
      if (conv) {
        events.push(conv);
        eventIndex += 1;
      }
    }
    if (revenuePerConversionCents > 0 && (revenueOnly || companionConversion)) {
      events.push(buildWebRevenueEvent(projectId, ts + eventIndex, revenuePerConversionCents));
    }
  } else {
    const conv = buildConversionEvent(metric, ts + eventIndex);
    if (conv) {
      events.push(conv);
    }
  }

  return {
    visitor_id: "preview_visitor",
    session_id: "preview_session",
    attributes: [],
    snapshots: [
      {
        decisions: [decision],
        events,
      },
    ],
  };
}

export async function postLogxBatch(params: {
  accountId: string;
  projectId: string;
  codeRevision?: string;
  visitors: LogxVisitor[];
}): Promise<{ ok: true; status: number } | { ok: false; status: number; body: string }> {
  const body = JSON.stringify({
    account_id: String(params.accountId),
    project_id: String(params.projectId),
    ...(params.codeRevision ? { revision: params.codeRevision } : {}),
    anonymize_ip: true,
    enrich_decisions: true,
    client_name: "optimizely-experiment-data/web",
    client_version: "1.0.0",
    visitors: params.visitors,
  });

  applyInsecureTlsIfConfigured();
  let res: Response;
  try {
    res = await fetch("https://logx.optimizely.com/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, status: 502, body: `logx unreachable: ${msg}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 800) };
  }
  return { ok: true, status: res.status };
}
