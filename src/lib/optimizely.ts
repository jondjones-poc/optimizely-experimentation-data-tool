import { applyInsecureTlsIfConfigured } from "@/lib/dev-tls";
import { logxEventShape } from "@/lib/logx-event-shape";

const API_BASE = "https://api.optimizely.com/v2";

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return "Network error reaching Optimizely API";
  const cause = err.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN"
  ) {
    return (
      "TLS certificate verification failed when calling Optimizely. " +
      "On corporate networks, install your organization's root CA or set OPTIMIZELY_INSECURE_TLS=1 in .env.local (dev only)."
    );
  }
  return `Network error reaching Optimizely API: ${err.message}`;
}

export type { VariationInfo } from "@/lib/variation-arms";
import { resolveControlTreatment, type TrafficMode, type VariationInfo } from "@/lib/variation-arms";
import { logxPropertiesForEventKey, STARTER_CUSTOM_EVENTS } from "@/lib/starter-metrics";

export type MetricKind = "revenue" | "click" | "pageview" | "custom";

/** Synthetic key for overall revenue metrics (sum on `revenue` field, no event_id). */
export const REVENUE_METRIC_KEY = "__overall_revenue__";

export type MetricEventInfo = {
  key: string;
  kind: MetricKind;
  name: string;
  event_id?: number;
  event_type?: string;
  aggregator?: string;
  field?: string;
  scope?: string;
  /** Per-metric override; falls back to batch defaults when omitted. */
  controlConversionRate?: number;
  treatmentConversionRate?: number;
  /** logx `properties` for custom events (string values per Event API). */
  logxProperties?: Record<string, string>;
};

function metricKindFromEventType(eventType: string): MetricKind {
  const t = eventType.toLowerCase();
  if (t === "click") return "click";
  if (t === "pageview") return "pageview";
  return "custom";
}

function metricFromExperimentRow(
  m: ExperimentMetric,
  ev?: { key?: string; event_type?: string; name?: string },
): MetricEventInfo | null {
  const isOverallRevenue =
    m.field === "revenue" && m.aggregator === "sum" && m.event_id == null;
  if (isOverallRevenue) {
    return {
      key: REVENUE_METRIC_KEY,
      kind: "revenue",
      name: "Overall revenue",
      aggregator: m.aggregator,
      field: m.field,
      scope: m.scope,
    };
  }

  if (m.event_id == null || !Number.isFinite(Number(m.event_id))) return null;
  if (!ev?.key) return null;

  const eventType = String(ev.event_type ?? "custom");
  const kind = metricKindFromEventType(eventType);
  const key = ev.key;
  const logxProperties = logxPropertiesForEventKey(key);
  return {
    event_id: Number(m.event_id),
    key,
    kind,
    name: String(ev.name ?? ev.key),
    event_type: eventType,
    aggregator: m.aggregator,
    field: m.field,
    scope: m.scope,
    ...(logxProperties ? { logxProperties } : {}),
  };
}

async function optimizelyFetch<T>(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  applyInsecureTlsIfConfigured();
  let res: Response;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const fetchInit: RequestInit = { method, headers, next: { revalidate: 0 } };
  if (init?.body != null) {
    headers["Content-Type"] = "application/json";
    fetchInit.body = JSON.stringify(init.body);
  }
  try {
    res = await fetch(`${API_BASE}${path}`, fetchInit);
  } catch (err) {
    return { ok: false, status: 502, message: formatFetchError(err) };
  }
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: text.slice(0, 500) || res.statusText,
    };
  }
  if (!text.trim()) {
    return { ok: true, data: {} as T };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, message: "Invalid JSON from Optimizely API" };
  }
}

type ProjectResponse = {
  id?: number;
  name?: string;
  account_id?: string | number;
  web_snippet?: { code_revision?: number };
};

export async function fetchProjectAccountId(
  token: string,
  projectId: string,
): Promise<{ accountId: string; codeRevision?: string } | { error: string; status?: number }> {
  const r = await optimizelyFetch<ProjectResponse>(`/projects/${encodeURIComponent(projectId)}`, token);
  if (!r.ok) return { error: r.message, status: r.status };
  const id = r.data.account_id;
  if (id == null) return { error: "Project response missing account_id" };
  const rev = r.data.web_snippet?.code_revision;
  return {
    accountId: String(id),
    ...(rev != null ? { codeRevision: String(rev) } : {}),
  };
}

type ExperimentMetric = {
  event_id?: number | null;
  aggregator?: string;
  scope?: string;
  field?: string;
  winning_direction?: string;
};

export type VariationWeightRow = {
  variation_id: string;
  name: string;
  weight: number;
};

type ExperimentResponse = {
  id?: number;
  name?: string;
  project_id?: number;
  status?: string;
  variations?: Array<{
    variation_id?: string | number;
    id?: string | number;
    name?: string;
    key?: string;
    weight?: number;
  }>;
  metrics?: ExperimentMetric[];
};

function experimentVariationRows(
  raw: ExperimentResponse["variations"],
): VariationWeightRow[] {
  const rows: VariationWeightRow[] = [];
  for (const v of raw ?? []) {
    const variation_id = String(v.variation_id ?? v.id ?? "").trim();
    if (!variation_id) continue;
    rows.push({
      variation_id,
      name: String(v.name ?? v.key ?? variation_id),
      weight: Number(v.weight ?? 0),
    });
  }
  return rows;
}

function equalVariationWeights(rows: VariationWeightRow[]): VariationWeightRow[] {
  const n = rows.length;
  if (n === 0) return rows;
  const base = Math.floor(10000 / n);
  let remaining = 10000;
  return rows.map((row, i) => {
    const weight = i === n - 1 ? remaining : base;
    remaining -= weight;
    return { ...row, weight };
  });
}

/** Set Optimizely experiment variation traffic (weights are basis points, 10000 = 100%). */
export async function setExperimentTrafficAllocation(
  token: string,
  experimentId: string,
  mode: TrafficMode,
  variations: VariationInfo[],
): Promise<
  | { mode: TrafficMode; weights: VariationWeightRow[]; treatmentName: string }
  | { error: string; status?: number }
> {
  const expR = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!expR.ok) return { error: expR.message, status: expR.status };

  const current = experimentVariationRows(expR.data.variations);
  if (current.length === 0) {
    return { error: "Experiment has no variations to reweight." };
  }

  let next: VariationWeightRow[];
  let treatmentName = "";

  if (mode === "all_treatment") {
    const { treatment } = resolveControlTreatment(variations);
    treatmentName = treatment.name;
    const treatmentId = treatment.variation_id;
    next = current.map((row) => ({
      ...row,
      weight: row.variation_id === treatmentId ? 10000 : 0,
    }));
  } else {
    next = equalVariationWeights(current);
    treatmentName = resolveControlTreatment(variations).treatment.name;
  }

  const patch = await optimizelyFetch<unknown>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
    {
      method: "PATCH",
      body: {
        variations: next.map((row) => ({
          variation_id: Number(row.variation_id),
          name: row.name,
          weight: row.weight,
        })),
      },
    },
  );
  if (!patch.ok) return { error: patch.message, status: patch.status };

  return { mode, weights: next, treatmentName };
}

export type ExperimentLifecycleAction = "start" | "pause";

/** GET experiment status from Optimizely (running, paused, not_started, …). */
export async function getExperimentStatus(
  token: string,
  experimentId: string,
): Promise<{ status: string } | { error: string; status?: number }> {
  const r = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!r.ok) return { error: r.message, status: r.status };
  return { status: String(r.data.status ?? "unknown") };
}

/** Start or pause experiment via PATCH ?action=start|pause (Web Experimentation). */
export async function setExperimentLifecycle(
  token: string,
  experimentId: string,
  action: ExperimentLifecycleAction,
): Promise<{ status?: string } | { error: string; status?: number }> {
  const r = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}?action=${action}`,
    token,
    { method: "PATCH", body: {} },
  );
  if (!r.ok) return { error: r.message, status: r.status };
  return { status: r.data.status ? String(r.data.status) : undefined };
}

export type DemoProjectProduct = "web" | "feature";

/** POST /v2/projects — sandbox project for demos. */
export async function createOptimizelyProject(
  token: string,
  name: string,
  product: DemoProjectProduct,
): Promise<{ projectId: string; name: string; product: DemoProjectProduct } | { error: string; status?: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Project name is required" };

  const body =
    product === "feature"
      ? {
          name: trimmed,
          platform: "custom",
          is_flags_enabled: true,
          sdks: ["javascript"],
        }
      : {
          name: trimmed,
          platform: "web",
          confidence_threshold: 0.9,
        };

  const r = await optimizelyFetch<{ id?: number; name?: string }>("/projects", token, {
    method: "POST",
    body,
  });
  if (!r.ok) return { error: r.message, status: r.status };
  if (r.data.id == null) return { error: "Project response missing id" };
  return {
    projectId: String(r.data.id),
    name: String(r.data.name ?? trimmed),
    product,
  };
}

/** Create Visited Page + Clicked on CTA custom events on a project (no experiment required). */
export async function createProjectStarterEvents(
  token: string,
  projectId: string,
): Promise<{ created: string[]; existing: string[] } | { error: string; status?: number }> {
  const created: string[] = [];
  const existing: string[] = [];

  for (const starter of STARTER_CUSTOM_EVENTS) {
    const prefixedKey = `${projectId}_${starter.key}`;
    const hit =
      (await findProjectEventByKey(token, projectId, prefixedKey)) ??
      (await findProjectEventByKey(token, projectId, starter.key));
    if (hit?.id != null) {
      existing.push(starter.name);
      continue;
    }
    const made = await createProjectCustomEvent(token, projectId, starter.name, prefixedKey);
    if ("error" in made) return made;
    created.push(starter.name);
  }

  return { created, existing };
}

export type DemoTestKind = "ab" | "multiarmed_bandit" | "personalization";

export type DemoTestMetricOptions = {
  revenue: boolean;
  visitedPage: boolean;
  clickedCta: boolean;
};

const DEMO_URL_TARGETING = {
  edit_url: "https://example.com",
  activation_type: "immediate" as const,
  conditions: JSON.stringify([
    "and",
    { type: "url", match_type: "substring", value: "example.com" },
  ]),
};

const DEMO_VARIATIONS = [
  { name: "Original", weight: 5000 },
  { name: "Variation #1", weight: 5000 },
];

async function ensureStarterEventId(
  token: string,
  projectId: string,
  starter: { name: string; key: string },
): Promise<number | { error: string; status?: number }> {
  const prefixedKey = `${projectId}_${starter.key}`;
  const existing =
    (await findProjectEventByKey(token, projectId, prefixedKey)) ??
    (await findProjectEventByKey(token, projectId, starter.key));
  if (existing?.id != null) return Number(existing.id);
  const made = await createProjectCustomEvent(token, projectId, starter.name, prefixedKey);
  if ("error" in made) return made;
  return made.id;
}

async function buildDemoTestMetrics(
  token: string,
  projectId: string,
  options: DemoTestMetricOptions,
): Promise<{ metrics: ExperimentMetric[]; attached: string[] } | { error: string; status?: number }> {
  const metrics: ExperimentMetric[] = [];
  const attached: string[] = [];

  if (options.revenue) {
    metrics.push({
      aggregator: "sum",
      field: "revenue",
      scope: "visitor",
      winning_direction: "increasing",
    });
    attached.push("Overall revenue");
  }

  if (options.visitedPage) {
    const eventId = await ensureStarterEventId(token, projectId, STARTER_CUSTOM_EVENTS[0]);
    if (typeof eventId !== "number") return eventId;
    metrics.push({
      aggregator: "unique",
      event_id: eventId,
      scope: "visitor",
      winning_direction: "increasing",
    });
    attached.push(STARTER_CUSTOM_EVENTS[0].name);
  }

  if (options.clickedCta) {
    const eventId = await ensureStarterEventId(token, projectId, STARTER_CUSTOM_EVENTS[1]);
    if (typeof eventId !== "number") return eventId;
    metrics.push({
      aggregator: "unique",
      event_id: eventId,
      scope: "visitor",
      winning_direction: "increasing",
    });
    attached.push(STARTER_CUSTOM_EVENTS[1].name);
  }

  if (metrics.length === 0) {
    return { error: "Select at least one metric." };
  }

  return { metrics, attached };
}

/** Create an A/B test, multi-arm bandit, or personalisation campaign experience with starter metrics. */
export async function createDemoTest(
  token: string,
  projectId: string,
  name: string,
  testKind: DemoTestKind,
  metricOptions: DemoTestMetricOptions,
): Promise<
  | {
      campaignId: string;
      experimentId: string;
      experimentName: string;
      testKind: DemoTestKind;
      metricsAttached: string[];
    }
  | { error: string; status?: number }
> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Test name is required." };

  const metricsResult = await buildDemoTestMetrics(token, projectId, metricOptions);
  if ("metrics" in metricsResult === false) return metricsResult;
  const { metrics, attached } = metricsResult;

  let campaignId = "";

  if (testKind === "personalization") {
    const campR = await optimizelyFetch<{ id?: number }>("/campaigns", token, {
      method: "POST",
      body: {
        project_id: Number(projectId),
        name: trimmed,
        type: "personalization",
        url_targeting: DEMO_URL_TARGETING,
      },
    });
    if (!campR.ok) return { error: campR.message, status: campR.status };
    if (campR.data.id == null) return { error: "Campaign response missing id" };
    campaignId = String(campR.data.id);
  }

  const experimentType =
    testKind === "ab"
      ? "a/b"
      : testKind === "multiarmed_bandit"
        ? "multiarmed_bandit"
        : "personalization";

  const experimentBody: Record<string, unknown> = {
    project_id: Number(projectId),
    name: trimmed,
    type: experimentType,
    url_targeting: DEMO_URL_TARGETING,
    variations: DEMO_VARIATIONS,
    metrics,
  };

  if (testKind === "personalization") {
    experimentBody.campaign_id = Number(campaignId);
  }

  const expR = await optimizelyFetch<{ id?: number; name?: string; campaign_id?: number }>(
    "/experiments",
    token,
    { method: "POST", body: experimentBody },
  );
  if (!expR.ok) return { error: expR.message, status: expR.status };
  if (expR.data.id == null) return { error: "Experiment response missing id" };

  const experimentId = String(expR.data.id);

  if (testKind !== "personalization") {
    if (expR.data.campaign_id != null) {
      campaignId = String(expR.data.campaign_id);
    } else {
      const meta = await getExperimentMeta(token, experimentId);
      if ("error" in meta) return { error: meta.error, status: meta.status };
      campaignId = meta.campaignId ?? "";
    }
  }

  if (!campaignId) {
    return {
      error:
        "Experiment created but campaign_id is missing. Paste the campaign ID from your Optimizely Results URL.",
      status: 502,
    };
  }

  return {
    campaignId,
    experimentId,
    experimentName: String(expR.data.name ?? trimmed),
    testKind,
    metricsAttached: attached,
  };
}

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

  const metrics: MetricEventInfo[] = [];
  for (const m of r.data.metrics ?? []) {
    const isOverallRevenue =
      m.field === "revenue" && m.aggregator === "sum" && m.event_id == null;
    if (isOverallRevenue) {
      const row = metricFromExperimentRow(m);
      if (row) metrics.push(row);
      continue;
    }

    if (m.event_id == null || !Number.isFinite(Number(m.event_id))) continue;
    const eid = Number(m.event_id);
    const ev = await optimizelyFetch<{ key?: string; event_type?: string; name?: string }>(
      `/events/${eid}`,
      token,
    );
    if (!ev.ok) {
      if (ev.status === 404) continue;
      return { error: `Event ${eid}: ${ev.message}`, status: ev.status };
    }
    const row = metricFromExperimentRow(m, ev.data);
    if (row) metrics.push(row);
  }

  return { variations, metrics };
}

export type NamedEntity = { id: string; name: string };

/** Campaign row from list/detail APIs; `type` is `personalization` | `other` per Optimizely Web docs. */
export type CampaignOption = NamedEntity & { type?: string };

function sortCampaigns(a: CampaignOption, b: CampaignOption): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function sortByName(a: NamedEntity, b: NamedEntity): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** GET /v2/projects — list all projects the token can access (paginated). */
export async function fetchProjectsForAccount(
  token: string,
): Promise<{ projects: NamedEntity[] } | { error: string; status?: number }> {
  const perPage = 100;
  const all: NamedEntity[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/projects?per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<unknown>(path, token);
    if (!r.ok) return { error: r.message, status: r.status };
    if (!Array.isArray(r.data)) {
      return { error: "Unexpected projects response (expected JSON array)" };
    }
    const batch = r.data as Array<{ id?: number; name?: string }>;
    for (const p of batch) {
      if (p.id == null) continue;
      all.push({ id: String(p.id), name: String(p.name ?? `Project ${p.id}`) });
    }
    if (batch.length < perPage) break;
  }
  all.sort(sortByName);
  return { projects: all };
}

/** GET /v2/campaigns?project_id= — see Optimizely list campaigns API. */
export async function fetchCampaignsForProject(
  token: string,
  projectId: string,
): Promise<{ campaigns: CampaignOption[] } | { error: string; status?: number }> {
  const perPage = 100;
  const all: CampaignOption[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/campaigns?project_id=${encodeURIComponent(projectId)}&per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<unknown>(path, token);
    if (!r.ok) return { error: r.message, status: r.status };
    if (!Array.isArray(r.data)) {
      return { error: "Unexpected campaigns response (expected JSON array)" };
    }
    const batch = r.data as Array<{ id?: number; name?: string; type?: string }>;
    for (const c of batch) {
      if (c.id == null) continue;
      all.push({
        id: String(c.id),
        name: String(c.name ?? `Campaign ${c.id}`),
        ...(c.type != null && c.type !== "" ? { type: String(c.type) } : {}),
      });
    }
    if (batch.length < perPage) break;
  }
  all.sort(sortCampaigns);
  return { campaigns: all };
}

type ExperimentListRow = {
  id?: number;
  name?: string;
  campaign_id?: number | null;
};

/** All experiments in a project (for discovery fallbacks). */
export async function fetchAllExperimentsForProject(
  token: string,
  projectId: string,
): Promise<{ rows: ExperimentListRow[] } | { error: string; status?: number }> {
  const perPage = 100;
  const rows: ExperimentListRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/experiments?project_id=${encodeURIComponent(projectId)}&per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<unknown>(path, token);
    if (!r.ok) return { error: r.message, status: r.status };
    if (!Array.isArray(r.data)) {
      return { error: "Unexpected experiments list (expected JSON array)" };
    }
    for (const e of r.data) {
      rows.push(e as ExperimentListRow);
    }
    if (r.data.length < perPage) break;
  }
  return { rows };
}

type CampaignDiscoveryMode =
  | "list"
  | "inferred_from_experiments"
  | "experiments_first"
  | "empty";

export type ProjectCampaignDiscovery = {
  campaigns: CampaignOption[];
  /** When list is empty, pick an experiment; campaign_id is filled by peek. */
  projectExperiments: NamedEntity[];
  mode: CampaignDiscoveryMode;
};

/**
 * /campaigns can be empty for some projects (e.g. feature-focused). Then we infer campaigns from
 * experiments' campaign_id, or return project-level experiments so the user can pick and resolve campaign via peek.
 *
 * When /campaigns returns a non-empty list, we still merge in every campaign_id seen on
 * /experiments?project_id= — some accounts return only a subset via the campaign list (e.g. one
 * personalization campaign) while A/B experiments belong to other campaign IDs.
 */
export async function discoverProjectCampaigns(
  token: string,
  projectId: string,
): Promise<ProjectCampaignDiscovery | { error: string; status?: number }> {
  const [fromList, exps] = await Promise.all([
    fetchCampaignsForProject(token, projectId),
    fetchAllExperimentsForProject(token, projectId),
  ]);
  if ("error" in fromList) return fromList;
  if ("error" in exps) return exps;

  const campaignById = new Map<string, { name: string; type?: string }>();
  for (const c of fromList.campaigns) {
    campaignById.set(c.id, { name: c.name, type: c.type });
  }

  const idsOnlyFromExperiments = new Set<string>();
  for (const e of exps.rows) {
    if (e == null || e.campaign_id == null) continue;
    const cid = String(e.campaign_id);
    if (!campaignById.has(cid)) {
      idsOnlyFromExperiments.add(cid);
    }
  }

  for (const cid of idsOnlyFromExperiments) {
    const r = await optimizelyFetch<{ name?: string; type?: string }>(
      `/campaigns/${encodeURIComponent(cid)}`,
      token,
    );
    if (r.ok) {
      campaignById.set(cid, {
        name: String(r.data.name ?? `Campaign ${cid}`),
        ...(r.data.type != null && r.data.type !== "" ? { type: String(r.data.type) } : {}),
      });
    } else {
      campaignById.set(cid, { name: `Campaign ${cid}` });
    }
  }

  const campaigns: CampaignOption[] = [...campaignById.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    ...(v.type != null && v.type !== "" ? { type: v.type } : {}),
  }));
  campaigns.sort(sortCampaigns);

  if (campaigns.length > 0) {
    const hadListCampaigns = fromList.campaigns.length > 0;
    const mode: CampaignDiscoveryMode = hadListCampaigns ? "list" : "inferred_from_experiments";
    return { campaigns, projectExperiments: [], mode };
  }

  const projectExperiments: NamedEntity[] = [];
  for (const e of exps.rows) {
    if (e.id == null) continue;
    projectExperiments.push({
      id: String(e.id),
      name: String(e.name ?? `Experiment ${e.id}`),
    });
  }
  projectExperiments.sort(sortByName);

  if (projectExperiments.length > 0) {
    return { campaigns: [], projectExperiments, mode: "experiments_first" };
  }
  return { campaigns: [], projectExperiments: [], mode: "empty" };
}

/** GET /v2/campaigns/{id} is optional helper — already used in discover. */
export async function getExperimentMeta(
  token: string,
  experimentId: string,
): Promise<
  { campaignId: string | null; name: string | null } | { error: string; status?: number }
> {
  const r = await optimizelyFetch<ExperimentListRow>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!r.ok) return { error: r.message, status: r.status };
  const c = r.data.campaign_id;
  return {
    campaignId: c == null ? null : String(c),
    name: r.data.name == null ? null : String(r.data.name),
  };
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

type EventListRow = { id?: number; key?: string; name?: string; event_type?: string };

async function findProjectEventByKey(
  token: string,
  projectId: string,
  eventKey: string,
): Promise<EventListRow | null> {
  const prefixed = `${projectId}_${eventKey}`;
  const perPage = 100;
  for (let page = 1; page <= 50; page++) {
    const path = `/events?project_id=${encodeURIComponent(projectId)}&per_page=${perPage}&page=${page}`;
    const r = await optimizelyFetch<EventListRow[]>(path, token);
    if (!r.ok) return null;
    if (!Array.isArray(r.data)) return null;
    const hit = r.data.find((e) => e.key === eventKey || e.key === prefixed);
    if (hit) return hit;
    if (r.data.length < perPage) break;
  }
  return null;
}

async function createProjectCustomEvent(
  token: string,
  projectId: string,
  name: string,
  key: string,
): Promise<{ id: number; key: string } | { error: string; status?: number }> {
  const r = await optimizelyFetch<{ id?: number; key?: string }>(
    `/projects/${encodeURIComponent(projectId)}/custom_events`,
    token,
    { method: "POST", body: { name, key, event_type: "custom" } },
  );
  if (!r.ok) return { error: r.message, status: r.status };
  if (r.data.id == null) return { error: "Custom event response missing id" };
  return { id: Number(r.data.id), key: String(r.data.key ?? key) };
}

/** Create Visited Page + Clicked on CTA Button custom events and attach as experiment metrics. */
export async function createStarterCustomMetrics(
  token: string,
  projectId: string,
  experimentId: string,
): Promise<{ created: string[]; attached: string[] } | { error: string; status?: number }> {
  const expR = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!expR.ok) return { error: expR.message, status: expR.status };

  const existingMetrics = [...(expR.data.metrics ?? [])];
  const attachedEventIds = new Set(
    existingMetrics.map((m) => m.event_id).filter((id): id is number => id != null),
  );

  const created: string[] = [];
  const attached: string[] = [];

  for (const starter of STARTER_CUSTOM_EVENTS) {
    let eventId: number | null = null;
    const prefixedKey = `${projectId}_${starter.key}`;

    const existing =
      (await findProjectEventByKey(token, projectId, prefixedKey)) ??
      (await findProjectEventByKey(token, projectId, starter.key));
    if (existing?.id != null) {
      eventId = Number(existing.id);
    } else {
      const made = await createProjectCustomEvent(token, projectId, starter.name, prefixedKey);
      if ("error" in made) return made;
      eventId = made.id;
      created.push(starter.name);
    }

    if (attachedEventIds.has(eventId)) continue;

    existingMetrics.push({
      aggregator: "unique",
      event_id: eventId,
      scope: "visitor",
      winning_direction: "increasing",
    });
    attachedEventIds.add(eventId);
    attached.push(starter.name);
  }

  if (attached.length === 0 && created.length === 0) {
    return { error: "Starter custom metrics already exist on this experiment." };
  }

  if (attached.length > 0) {
    const patch = await optimizelyFetch<unknown>(
      `/experiments/${encodeURIComponent(experimentId)}`,
      token,
      { method: "PATCH", body: { metrics: existingMetrics } },
    );
    if (!patch.ok) return { error: patch.message, status: patch.status };
  }

  return { created, attached };
}

type ResultsVariationRow = {
  level?: string;
  name?: string;
  samples?: number;
  variation_id?: string;
  is_baseline?: boolean;
  value?: number;
  rate?: number;
  lift?: {
    value?: number;
    is_significant?: boolean;
    lift_status?: string;
    significance?: number;
  };
};

type ResultsMetricBlock = {
  name?: string;
  aggregator?: string;
  field?: string;
  event_id?: number;
  results?: Record<string, ResultsVariationRow>;
  conclusion?: { winner?: string };
};

type ResultsReach = {
  total_count?: number;
  baseline_count?: number;
  treatment_count?: number;
  baseline_reach?: number;
  treatment_reach?: number;
};

type ExperimentResultsResponse = {
  experiment_id?: number;
  start_time?: string;
  end_time?: string;
  last_calculated_time?: string;
  is_stale?: boolean;
  confidence_threshold?: number;
  stats_config?: { confidence_level?: number; difference_type?: string };
  reach?: ResultsReach;
  metrics?: ResultsMetricBlock[];
};

export type ValidationCheckStatus = "pass" | "warn" | "fail";

export type ValidationCheck = {
  status: ValidationCheckStatus;
  title: string;
  detail: string;
};

export type ExperimentResultsMeta = {
  startTime?: string;
  endTime?: string;
  lastCalculated?: string;
  isStale?: boolean;
  confidenceThreshold?: number;
  confidenceLevel?: number;
  differenceType?: string;
  totalVisitors: number;
  baselineVisitors: number;
  treatmentVisitors: number;
  baselineReachPercent?: number;
  treatmentReachPercent?: number;
};

export type ExperimentResultsVariation = {
  name: string;
  variationId?: string;
  visitors: number;
  conversions: number;
  ratePercent: number;
  liftPercent?: number;
  liftSignificant?: boolean;
  liftStatus?: string;
  isBaseline: boolean;
  isWinner?: boolean;
};

export type ExperimentResultsMetric = {
  name: string;
  aggregator?: string;
  field?: string;
  eventId?: number;
  winnerVariationId?: string;
  variations: ExperimentResultsVariation[];
};

/** @deprecated Use ExperimentResultsMetric */
export type ExperimentResultsSummary = {
  lastCalculated?: string;
  meta?: ExperimentResultsMeta;
  metrics: ExperimentResultsMetric[];
};

export type ExperimentValidationReport = {
  experimentId: string;
  experimentName?: string;
  projectId?: string;
  projectName?: string;
  experimentStatus?: string;
  meta: ExperimentResultsMeta;
  checks: ValidationCheck[];
  metrics: ExperimentResultsMetric[];
};

function formatRevenueFromResults(value: number): number {
  return value / 100;
}

function parseExperimentResultsResponse(data: ExperimentResultsResponse): {
  meta: ExperimentResultsMeta;
  metrics: ExperimentResultsMetric[];
} {
  const reach = data.reach ?? {};
  const meta: ExperimentResultsMeta = {
    startTime: data.start_time,
    endTime: data.end_time,
    lastCalculated: data.last_calculated_time,
    isStale: data.is_stale,
    confidenceThreshold: data.confidence_threshold,
    confidenceLevel: data.stats_config?.confidence_level,
    differenceType: data.stats_config?.difference_type,
    totalVisitors: Number(reach.total_count ?? 0),
    baselineVisitors: Number(reach.baseline_count ?? 0),
    treatmentVisitors: Number(reach.treatment_count ?? 0),
    baselineReachPercent:
      reach.baseline_reach != null ? Number(reach.baseline_reach) * 100 : undefined,
    treatmentReachPercent:
      reach.treatment_reach != null ? Number(reach.treatment_reach) * 100 : undefined,
  };

  const metrics: ExperimentResultsMetric[] = [];
  for (const m of data.metrics ?? []) {
    const name = String(m.name ?? "Metric");
    const winnerId = m.conclusion?.winner;
    const variations: ExperimentResultsVariation[] = [];
    for (const row of Object.values(m.results ?? {})) {
      if (row.level !== "variation") continue;
      const rawValue = Number(row.value ?? 0);
      const isRevenue = m.field === "revenue" && m.aggregator === "sum";
      const conversions = isRevenue ? formatRevenueFromResults(rawValue) : rawValue;
      const rate = Number(row.rate ?? 0);
      const ratePercent = isRevenue ? 0 : rate * 100;
      const lift = row.lift;
      const variationId = row.variation_id != null ? String(row.variation_id) : undefined;
      variations.push({
        name: String(row.name ?? variationId ?? "Variation"),
        variationId,
        visitors: Number(row.samples ?? 0),
        conversions,
        ratePercent,
        ...(lift?.value != null ? { liftPercent: lift.value * 100 } : {}),
        ...(lift?.is_significant != null ? { liftSignificant: lift.is_significant } : {}),
        ...(lift?.lift_status ? { liftStatus: lift.lift_status } : {}),
        isBaseline: row.is_baseline === true,
        ...(winnerId && variationId === winnerId ? { isWinner: true } : {}),
      });
    }
    variations.sort((a, b) => Number(b.isBaseline) - Number(a.isBaseline));
    metrics.push({
      name,
      aggregator: m.aggregator,
      field: m.field,
      ...(m.event_id != null ? { eventId: Number(m.event_id) } : {}),
      ...(winnerId ? { winnerVariationId: winnerId } : {}),
      variations,
    });
  }

  return { meta, metrics };
}

function pushCheck(
  checks: ValidationCheck[],
  status: ValidationCheckStatus,
  title: string,
  detail: string,
): void {
  checks.push({ status, title, detail });
}

/** Pull experiment Results from Optimizely REST API (same data as Results page). */
export async function fetchExperimentResultsSummary(
  token: string,
  experimentId: string,
): Promise<ExperimentResultsSummary | { error: string; status?: number }> {
  const r = await optimizelyFetch<ExperimentResultsResponse>(
    `/experiments/${encodeURIComponent(experimentId)}/results`,
    token,
  );
  if (!r.ok) return { error: r.message, status: r.status };

  const { meta, metrics } = parseExperimentResultsResponse(r.data);
  return {
    lastCalculated: meta.lastCalculated,
    meta,
    metrics,
  };
}

/** Config + event keys + Results API — validates setup and that metrics are counting. */
export async function validateExperimentSetup(
  token: string,
  experimentId: string,
  expectedMetrics: MetricEventInfo[],
): Promise<ExperimentValidationReport | { error: string; status?: number }> {
  const expR = await optimizelyFetch<ExperimentResponse>(
    `/experiments/${encodeURIComponent(experimentId)}`,
    token,
  );
  if (!expR.ok) return { error: expR.message, status: expR.status };

  const experimentName = String(expR.data.name ?? "").trim() || undefined;
  const projectId =
    expR.data.project_id != null ? String(expR.data.project_id) : undefined;
  let projectName: string | undefined;
  if (projectId) {
    const projectR = await optimizelyFetch<ProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}`,
      token,
    );
    if (projectR.ok) {
      const name = String(projectR.data.name ?? "").trim();
      if (name) projectName = name;
    }
  }

  const resultsR = await optimizelyFetch<ExperimentResultsResponse>(
    `/experiments/${encodeURIComponent(experimentId)}/results`,
    token,
  );
  if (!resultsR.ok) return { error: resultsR.message, status: resultsR.status };

  const { meta, metrics: resultsMetrics } = parseExperimentResultsResponse(resultsR.data);
  const checks: ValidationCheck[] = [];
  const status = String(expR.data.status ?? "").toLowerCase();

  if (status === "running") {
    pushCheck(checks, "pass", "Experiment is running", `status=${expR.data.status}`);
  } else {
    pushCheck(
      checks,
      "warn",
      "Experiment is not running",
      `status=${expR.data.status ?? "unknown"} — activations may not count in Results`,
    );
  }

  if (meta.totalVisitors > 0) {
    pushCheck(
      checks,
      "pass",
      "Visitors recorded in Results",
      `${meta.totalVisitors.toLocaleString()} total (${meta.baselineVisitors.toLocaleString()} baseline, ${meta.treatmentVisitors.toLocaleString()} treatment)`,
    );
  } else {
    pushCheck(checks, "fail", "No visitors in Results", "Send logx batches with campaign_activated + decisions");
  }

  if (meta.isStale) {
    pushCheck(checks, "warn", "Results may be stale", "is_stale=true — refresh again in a few minutes");
  } else if (meta.lastCalculated) {
    pushCheck(
      checks,
      "pass",
      "Results calculated",
      `Last calculated ${new Date(meta.lastCalculated).toLocaleString()}`,
    );
  }

  if (meta.startTime && meta.endTime) {
    pushCheck(
      checks,
      "pass",
      "Results date range",
      `${new Date(meta.startTime).toLocaleDateString()} → ${new Date(meta.endTime).toLocaleDateString()}`,
    );
  }

  const weights = experimentVariationRows(expR.data.variations);
  const allOnOne = weights.some((w) => w.weight === 10000) && weights.some((w) => w.weight === 0);
  if (allOnOne) {
    pushCheck(checks, "pass", "Traffic allocation", "100% on one variation (Optimizely weights)");
  } else if (weights.every((w) => w.weight === weights[0]?.weight)) {
    pushCheck(checks, "pass", "Traffic allocation", "Balanced split across variations");
  } else {
    pushCheck(
      checks,
      "warn",
      "Traffic allocation",
      weights.map((w) => `${w.name}=${w.weight / 100}%`).join(", "),
    );
  }

  for (const expected of expectedMetrics) {
    if (expected.kind === "revenue") continue;
    if (expected.event_id == null) continue;

    const eventR = await optimizelyFetch<{ key?: string; event_type?: string; name?: string }>(
      `/events/${expected.event_id}`,
      token,
    );
    if (!eventR.ok) {
      pushCheck(
        checks,
        "fail",
        `${expected.name}: event lookup`,
        `GET /events/${expected.event_id} failed — ${eventR.message}`,
      );
      continue;
    }

    const apiKey = String(eventR.data.key ?? "");
    if (apiKey && apiKey === expected.key) {
      pushCheck(
        checks,
        "pass",
        `${expected.name}: event key`,
        `API key ${apiKey} matches loaded metric`,
      );
    } else {
      pushCheck(
        checks,
        "fail",
        `${expected.name}: event key mismatch`,
        `API key=${apiKey || "—"} vs loaded key=${expected.key}`,
      );
    }

    const shape = logxEventShape(expected);
    pushCheck(
      checks,
      "pass",
      `${expected.name}: logx shape`,
      `entity_id=${shape.entity_id} key=${shape.key}`,
    );

    const onExperiment = (expR.data.metrics ?? []).some(
      (m) => m.event_id != null && Number(m.event_id) === expected.event_id,
    );
    if (onExperiment) {
      pushCheck(checks, "pass", `${expected.name}: on experiment`, `event_id ${expected.event_id} attached`);
    } else {
      pushCheck(
        checks,
        "fail",
        `${expected.name}: not on experiment`,
        `event_id ${expected.event_id} missing from experiment metrics`,
      );
    }

    const resultMetric = resultsMetrics.find(
      (m) =>
        (expected.event_id != null && m.eventId === expected.event_id) ||
        m.name.toLowerCase() === expected.name.toLowerCase(),
    );
    if (!resultMetric) {
      pushCheck(checks, "fail", `${expected.name}: Results row`, "No matching metric in /results response");
      continue;
    }

    const totalConversions = resultMetric.variations.reduce((s, v) => s + v.conversions, 0);
    if (totalConversions > 0) {
      const top = resultMetric.variations.reduce((a, b) => (b.conversions > a.conversions ? b : a));
      pushCheck(
        checks,
        "pass",
        `${expected.name}: counting in Results`,
        `${totalConversions.toLocaleString()} total unique conversions (peak ${top.name}: ${top.conversions.toLocaleString()})`,
      );
    } else {
      pushCheck(
        checks,
        "fail",
        `${expected.name}: zero in Results`,
        "Events accepted by logx but not matched — check logx key/entity_id or re-send after fix",
      );
    }

    const treatment = resultMetric.variations.find((v) => !v.isBaseline);
    if (treatment?.liftSignificant && treatment.liftPercent != null) {
      pushCheck(
        checks,
        "pass",
        `${expected.name}: statistical lift`,
        `${treatment.liftStatus ?? "lift"} ${treatment.liftPercent >= 0 ? "+" : ""}${treatment.liftPercent.toFixed(0)}% vs baseline (significant)`,
      );
    } else if (treatment?.liftPercent != null) {
      pushCheck(
        checks,
        "warn",
        `${expected.name}: improvement`,
        `${treatment.liftPercent >= 0 ? "+" : ""}${treatment.liftPercent.toFixed(0)}% vs baseline (not yet significant)`,
      );
    }
  }

  const revenueResult = resultsMetrics.find((m) => m.field === "revenue" && m.aggregator === "sum");
  if (revenueResult) {
    const total = revenueResult.variations.reduce((s, v) => s + v.conversions, 0);
    pushCheck(
      checks,
      total > 0 ? "pass" : "warn",
      "Overall revenue in Results",
      total > 0
        ? `$${total.toLocaleString(undefined, { maximumFractionDigits: 0 })} total (sum metric value/100)`
        : "No revenue counted yet",
    );
  }

  return {
    experimentId,
    ...(experimentName ? { experimentName } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    experimentStatus: expR.data.status,
    meta,
    checks,
    metrics: resultsMetrics,
  };
}
