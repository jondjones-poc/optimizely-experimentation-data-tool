import type { CampaignOption } from "@/lib/optimizely";

const COOKIE_NAME = "oed";
const STORAGE_KEY = "optimizely-experiment-data:state";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export type TrafficMode = "balanced" | "all_treatment";

export type SavedPicks = {
  projectId: string;
  campaignId: string;
  experimentId: string;
  manualIds: boolean;
  visitorCount: string;
  revenuePerConversion: string;
  trafficMode: TrafficMode;
};

export type MetricRateFields = { control: string; treatment: string };

export type NamedEntity = { id: string; name: string };

export type PersistedMetric = {
  key: string;
  kind: string;
  name: string;
  event_id?: number;
  event_type?: string;
  logxProperties?: Record<string, string>;
};

export type PersistedLoadResult = {
  accountId: string;
  codeRevision?: string;
  experimentStartTime?: string;
  variations: { variation_id: string; name: string }[];
  metrics: PersistedMetric[];
};

export type SavedCache = {
  accountProjects: NamedEntity[];
  campaigns: CampaignOption[];
  projectExperiments: NamedEntity[];
  experiments: NamedEntity[];
  afterDiscovery: boolean;
  pickerKind: "campaign_chain" | "project_experiment" | null;
  discoveryMode: string | null;
  loaded: PersistedLoadResult | null;
  selectedKeys: string[];
  metricRates: Record<string, MetricRateFields>;
};

export type PersistedFormState = {
  v: 1;
  picks: SavedPicks;
  cache: SavedCache;
};

export const EMPTY_PICKS: SavedPicks = {
  projectId: "",
  campaignId: "",
  experimentId: "",
  manualIds: false,
  visitorCount: "100000",
  revenuePerConversion: "100000",
  trafficMode: "balanced",
};

export const EMPTY_CACHE: SavedCache = {
  accountProjects: [],
  campaigns: [],
  projectExperiments: [],
  experiments: [],
  afterDiscovery: false,
  pickerKind: null,
  discoveryMode: null,
  loaded: null,
  selectedKeys: [],
  metricRates: {},
};

function normalizePicks(raw: Partial<SavedPicks> | null | undefined): SavedPicks {
  return {
    projectId: String(raw?.projectId ?? "").trim(),
    campaignId: String(raw?.campaignId ?? "").trim(),
    experimentId: String(raw?.experimentId ?? "").trim(),
    manualIds: raw?.manualIds === true,
    visitorCount: String(raw?.visitorCount ?? EMPTY_PICKS.visitorCount),
    revenuePerConversion: String(raw?.revenuePerConversion ?? EMPTY_PICKS.revenuePerConversion),
    trafficMode: raw?.trafficMode === "all_treatment" ? "all_treatment" : "balanced",
  };
}

function normalizeCache(raw: Partial<SavedCache> | null | undefined): SavedCache {
  return {
    accountProjects: Array.isArray(raw?.accountProjects) ? raw!.accountProjects : [],
    campaigns: Array.isArray(raw?.campaigns) ? raw!.campaigns : [],
    projectExperiments: Array.isArray(raw?.projectExperiments) ? raw!.projectExperiments : [],
    experiments: Array.isArray(raw?.experiments) ? raw!.experiments : [],
    afterDiscovery: raw?.afterDiscovery === true,
    pickerKind:
      raw?.pickerKind === "campaign_chain" || raw?.pickerKind === "project_experiment"
        ? raw.pickerKind
        : null,
    discoveryMode: raw?.discoveryMode ?? null,
    loaded: raw?.loaded ?? null,
    selectedKeys: Array.isArray(raw?.selectedKeys) ? raw!.selectedKeys : [],
    metricRates:
      raw?.metricRates && typeof raw.metricRates === "object" ? raw.metricRates : {},
  };
}

function readCookiePicks(): SavedPicks | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  if (!match) return null;
  try {
    return normalizePicks(JSON.parse(decodeURIComponent(match[1])) as Partial<SavedPicks>);
  } catch {
    return null;
  }
}

function writeCookiePicks(picks: SavedPicks): void {
  if (typeof document === "undefined") return;
  try {
    const value = encodeURIComponent(JSON.stringify(picks));
    document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SEC}; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

function clearCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
}

export function readSavedFormState(): PersistedFormState {
  if (typeof window === "undefined") {
    return { v: 1, picks: EMPTY_PICKS, cache: EMPTY_CACHE };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedFormState>;
      if (parsed.v === 1) {
        return {
          v: 1,
          picks: normalizePicks(parsed.picks),
          cache: normalizeCache(parsed.cache),
        };
      }
    }
  } catch {
    /* fall through */
  }

  const cookiePicks = readCookiePicks();
  return {
    v: 1,
    picks: cookiePicks ?? EMPTY_PICKS,
    cache: EMPTY_CACHE,
  };
}

export function writeSavedFormState(state: PersistedFormState): void {
  if (typeof window === "undefined") return;
  const picks = normalizePicks(state.picks);
  const cache = normalizeCache(state.cache);
  writeCookiePicks(picks);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, picks, cache }));
  } catch {
    /* quota / private mode */
  }
}

export function clearSavedFormState(): void {
  if (typeof window === "undefined") return;
  clearCookie();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem("optimizely-experiment-data:picks");
  } catch {
    /* legacy */
  }
}
