const API_BASE = "https://api.optimizely.com/v2";

export type VariationInfo = { variation_id: string; name: string };

export type MetricEventInfo = {
  event_id: number;
  key: string;
};

async function optimizelyFetch<T>(
  path: string,
  token: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 0 },
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: text.slice(0, 500) || res.statusText,
    };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, message: "Invalid JSON from Optimizely API" };
  }
}

type ProjectResponse = { id?: number; account_id?: string | number };

export async function fetchProjectAccountId(
  token: string,
  projectId: string,
): Promise<{ accountId: string } | { error: string; status?: number }> {
  const r = await optimizelyFetch<ProjectResponse>(`/projects/${encodeURIComponent(projectId)}`, token);
  if (!r.ok) return { error: r.message, status: r.status };
  const id = r.data.account_id;
  if (id == null) return { error: "Project response missing account_id" };
  return { accountId: String(id) };
}

type ExperimentMetric = {
  event_id?: number | null;
  aggregator?: string;
  scope?: string;
  field?: string;
  winning_direction?: string;
};

type ExperimentResponse = {
  id?: number;
  variations?: Array<{
    variation_id?: string | number;
    id?: string | number;
    name?: string;
    key?: string;
  }>;
  metrics?: ExperimentMetric[];
};

export async function fetchExperimentDetails(
  token: string,
  experimentId: string,
): Promise<
  | {
      variations: VariationInfo[];
      metrics: MetricEventInfo[];
    }
  | { error: string; status?: number }
> {
  const r = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!r.ok) return { error: r.message, status: r.status };

  const variations: VariationInfo[] = (r.data.variations ?? []).map((v) => {
    const vid = v.variation_id ?? v.id;
    return {
      variation_id: String(vid ?? ""),
      name: v.name ?? v.key ?? String(vid ?? "variation"),
    };
  }).filter((v) => v.variation_id.length > 0);

  const withEventIds = (r.data.metrics ?? []).filter(
    (m): m is ExperimentMetric & { event_id: number } =>
      m.event_id != null && Number.isFinite(Number(m.event_id)),
  );

  const metrics: MetricEventInfo[] = [];
  for (const m of withEventIds) {
    const eid = Number(m.event_id);
    const ev = await optimizelyFetch<{ key?: string }>(`/events/${eid}`, token);
    if (!ev.ok) {
      if (ev.status === 404) continue;
      return { error: `Event ${eid}: ${ev.message}`, status: ev.status };
    }
    if (!ev.data.key) continue;
    metrics.push({ event_id: eid, key: ev.data.key });
  }

  return { variations, metrics };
}

export type NamedEntity = { id: string; name: string };

function sortByName(a: NamedEntity, b: NamedEntity): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** GET /v2/campaigns?project_id= — see Optimizely list campaigns API. */
export async function fetchCampaignsForProject(
  token: string,
  projectId: string,
): Promise<{ campaigns: NamedEntity[] } | { error: string; status?: number }> {
  const perPage = 100;
  const all: NamedEntity[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/campaigns?project_id=${encodeURIComponent(projectId)}&per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<unknown>(path, token);
    if (!r.ok) return { error: r.message, status: r.status };
    if (!Array.isArray(r.data)) {
      return { error: "Unexpected campaigns response (expected JSON array)" };
    }
    const batch = r.data as Array<{ id?: number; name?: string }>;
    for (const c of batch) {
      if (c.id == null) continue;
      all.push({ id: String(c.id), name: String(c.name ?? `Campaign ${c.id}`) });
    }
    if (batch.length < perPage) break;
  }
  all.sort(sortByName);
  return { campaigns: all };
}

/** GET /v2/experiments?campaign_id= — either project_id or campaign_id is required; we scope by campaign. */
export async function fetchExperimentsForCampaign(
  token: string,
  campaignId: string,
): Promise<{ experiments: NamedEntity[] } | { error: string; status?: number }> {
  const perPage = 100;
  const all: NamedEntity[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/experiments?campaign_id=${encodeURIComponent(campaignId)}&per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<unknown>(path, token);
    if (!r.ok) return { error: r.message, status: r.status };
    if (!Array.isArray(r.data)) {
      return { error: "Unexpected experiments list response (expected JSON array)" };
    }
    const batch = r.data as Array<{ id?: number; name?: string }>;
    for (const e of batch) {
      if (e.id == null) continue;
      all.push({ id: String(e.id), name: String(e.name ?? `Experiment ${e.id}`) });
    }
    if (batch.length < perPage) break;
  }
  all.sort(sortByName);
  return { experiments: all };
}
