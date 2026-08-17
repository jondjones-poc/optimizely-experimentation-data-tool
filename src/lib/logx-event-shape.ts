import type { MetricEventInfo } from "@/lib/optimizely";

/**
 * Resolve logx `entity_id` + `key` per Optimizely Web + Event API.
 * @see https://support.optimizely.com/hc/en-us/articles/4410289444493 (key = api_name for click/custom)
 * @see https://docs.developers.optimizely.com/experimentation-data/reference/post_events
 */
export function logxEventShape(m: MetricEventInfo): { entity_id: string; key: string } {
  const eventId = String(m.event_id ?? "");
  if (!eventId) return { entity_id: "", key: m.key };

  if (m.kind === "pageview") {
    // Web pageview: `key` is the page ID (same as entity_id).
    return { entity_id: eventId, key: eventId };
  }

  // Click + custom: api_name as key, event id as entity_id.
  return { entity_id: eventId, key: m.key };
}

export function describeLogxEvent(m: MetricEventInfo): string {
  const shape = logxEventShape(m);
  if (m.kind === "pageview") {
    return `logx key=pageId (${shape.key})`;
  }
  return `logx entity_id=${shape.entity_id} key=${shape.key}`;
}
