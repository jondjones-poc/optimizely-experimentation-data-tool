import { randomUUID } from "crypto";
import type { MetricEventInfo, VariationInfo } from "./optimizely";

const BROWSERS = ["gc", "ff", "safari", "ie"] as const;
const DEVICES = ["iphone", "ipad", "desktop"] as const;
const SOURCES = ["search", "direct", "campaign", "social"] as const;
const CAMPAIGNS = ["winter campaign", "frequent visitors", "discount", "retargeting"] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export type LogxVisitor = {
  visitor_id: string;
  session_id: string;
  attributes: Array<{ entity_id: number; type: string; value: string }>;
  snapshots: Array<{
    decisions: Array<{
      campaign_id: string;
      experiment_id: string;
      variation_id: string;
      is_campaign_holdback: boolean;
    }>;
    events: Array<Record<string, unknown>>;
  }>;
};

export function buildVisitor(params: {
  campaignId: string;
  experimentId: string;
  variations: VariationInfo[];
  metricsToFire: MetricEventInfo[];
  conversionProbability: number;
  nowMs: number;
  timeOffsetMs?: number;
}): LogxVisitor {
  const {
    campaignId,
    experimentId,
    variations,
    metricsToFire,
    conversionProbability,
    nowMs,
    timeOffsetMs = 0,
  } = params;

  const variation_id = pick(variations.map((v) => v.variation_id));
  const ts = nowMs + timeOffsetMs;

  const events: Array<Record<string, unknown>> = [
    {
      entity_id: String(campaignId),
      uuid: randomUUID().toUpperCase(),
      key: "campaign_activated",
      timestamp: ts,
    },
  ];

  for (const m of metricsToFire) {
    if (Math.random() < conversionProbability) {
      events.push({
        entity_id: m.event_id,
        uuid: randomUUID().toUpperCase(),
        key: m.key,
        timestamp: ts,
        revenue: Math.floor(Math.random() * 19000) + 1000,
        value: Math.round((Math.random() * 190 + 10) * 100) / 100,
        tags: { $opt_event_properties: {} },
      });
    }
  }

  return {
    visitor_id: `visitor_${randomUUID().replace(/-/g, "")}`,
    session_id: `session_${randomUUID().replace(/-/g, "")}`,
    attributes: [
      { entity_id: 100, type: "browserId", value: pick(BROWSERS) },
      { entity_id: 200, type: "campaign", value: pick(CAMPAIGNS) },
      { entity_id: 300, type: "device", value: pick(DEVICES) },
      { entity_id: 600, type: "source_type", value: pick(SOURCES) },
    ],
    snapshots: [
      {
        decisions: [
          {
            campaign_id: String(campaignId),
            experiment_id: String(experimentId),
            variation_id: String(variation_id),
            is_campaign_holdback: false,
          },
        ],
        events,
      },
    ],
  };
}

export async function postLogxBatch(params: {
  accountId: string;
  projectId: string;
  visitors: LogxVisitor[];
}): Promise<{ ok: true; status: number } | { ok: false; status: number; body: string }> {
  const body = JSON.stringify({
    account_id: String(params.accountId),
    project_id: String(params.projectId),
    anonymize_ip: true,
    client_name: "optimizely-experiment-data/web",
    client_version: "1.0.0",
    visitors: params.visitors,
  });

  const res = await fetch("https://logx.optimizely.com/v1/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 800) };
  }
  return { ok: true, status: res.status };
}
