"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearSavedFormState,
  EMPTY_PICKS,
  readSavedFormState,
  writeSavedFormState,
  type MetricRateFields,
  type TrafficMode,
} from "@/lib/form-persistence";
import { describeLogxEvent } from "@/lib/logx-event-shape";
import { WEB_REVENUE_EVENT_KEY } from "@/lib/logx";
import { type CampaignOption, type DemoTestKind, type MetricKind } from "@/lib/optimizely";
import type { ExperimentValidationReport, ValidationCheckStatus } from "@/lib/optimizely";
import {
  DEFAULT_CONTROL_RATE,
  DEFAULT_TREATMENT_RATE,
} from "@/lib/starter-metrics";
import { resolveControlTreatment } from "@/lib/variation-arms";

type Variation = { variation_id: string; name: string };
type Metric = {
  key: string;
  kind: MetricKind;
  name: string;
  event_id?: number;
  event_type?: string;
  logxProperties?: Record<string, string>;
};

function isConversionMetric(m: Metric): boolean {
  return m.kind !== "revenue" && m.event_id != null;
}

function metricKindLabel(kind: MetricKind): string {
  switch (kind) {
    case "revenue":
      return "Revenue";
    case "click":
      return "Conversion (click)";
    case "pageview":
      return "Conversion (pageview)";
    default:
      return "Conversion (custom)";
  }
}

function metricKindBadgeClass(kind: MetricKind): string {
  switch (kind) {
    case "revenue":
      return "opt-badge-revenue";
    case "click":
      return "opt-badge-click";
    case "pageview":
      return "opt-badge-pageview";
    default:
      return "opt-badge-custom";
  }
}
type NamedEntity = { id: string; name: string };

type LoadResult = {
  accountId: string;
  codeRevision?: string;
  experimentStartTime?: string;
  variations: Variation[];
  metrics: Metric[];
};

const BATCH_SIZE = 1000;
const BATCH_DELAY_MS = 2000;

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function delayMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function parseRate(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function seedAllMetricRates(metrics: Metric[]): Record<string, MetricRateFields> {
  const out: Record<string, MetricRateFields> = {};
  for (const m of metrics) {
    if (m.kind === "revenue" || isConversionMetric(m)) {
      out[m.key] = { control: DEFAULT_CONTROL_RATE, treatment: DEFAULT_TREATMENT_RATE };
    }
  }
  return out;
}

function TokenVisibilityIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        className="size-5"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M1 1l22 22" />
      </svg>
    );
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className="size-5"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AllTrafficToVariationButton({
  applying,
  active,
  treatmentName,
  onClick,
}: {
  applying: boolean;
  active: boolean;
  treatmentName?: string;
  onClick: () => void;
}) {
  const treatmentLabel = treatmentName ?? "treatment variation";
  const label = active
    ? `Restore balanced traffic (50/50)`
    : `All traffic to ${treatmentLabel}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={active ? "opt-btn-active" : "opt-btn-secondary"}
    >
      {applying ? "Updating Optimizely traffic…" : label}
    </button>
  );
}

function CopyValidationDetailsButton({
  disabled,
  onCopy,
}: {
  disabled?: boolean;
  onCopy: () => Promise<void> | void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        void (async () => {
          await onCopy();
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        })();
      }}
      className="opt-btn-secondary"
    >
      {copied ? "Copied!" : "Copy validation details"}
    </button>
  );
}

function buildValidationClipboardText(params: {
  loaded: LoadResult;
  projectId: string;
  campaignId: string;
  experimentId: string;
  trafficMode: TrafficMode;
  visitorCount: string;
  revenuePerConversion: string;
  selectedKeys: Set<string>;
  metricRates: Record<string, MetricRateFields>;
  controlTreatment: ReturnType<typeof resolveControlTreatment> | null;
  treatmentVisitors: number;
  totalVisitors: number;
}): string {
  const {
    loaded,
    projectId,
    campaignId,
    experimentId,
    trafficMode,
    visitorCount,
    revenuePerConversion,
    selectedKeys,
    metricRates,
    controlTreatment,
    treatmentVisitors,
    totalVisitors,
  } = params;

  const lines: string[] = [
    "Optimizely logx validation bundle",
    `Generated: ${new Date().toISOString()}`,
    "",
    "IDs",
    `Account ID: ${loaded.accountId}`,
    `Project ID: ${projectId.trim() || "—"}`,
    `Campaign ID: ${campaignId.trim() || "—"}`,
    `Experiment ID: ${experimentId.trim() || "—"}`,
    ...(loaded.codeRevision ? [`Code revision: ${loaded.codeRevision}`] : []),
    "",
    "Variations",
  ];

  for (const v of loaded.variations) {
    const role =
      controlTreatment?.control.variation_id === v.variation_id
        ? "control"
        : controlTreatment?.treatment.variation_id === v.variation_id
          ? "treatment"
          : "other";
    lines.push(`${v.name} (${v.variation_id}) — ${role}`);
  }

  lines.push(
    "",
    "Send settings",
    `Traffic mode: ${trafficMode === "all_treatment" ? "all_treatment (100% to treatment)" : "balanced (50/50)"}`,
    `Visitors to simulate: ${visitorCount}`,
    `Treatment-arm visitors (estimate): ${treatmentVisitors.toLocaleString()} of ${totalVisitors.toLocaleString()}`,
    `Revenue per converting event (USD): ${revenuePerConversion}`,
    "",
    "Metrics",
  );

  for (const m of loaded.metrics) {
    const checked = selectedKeys.has(m.key);
    const rates = metricRates[m.key] ?? {
      control: DEFAULT_CONTROL_RATE,
      treatment: DEFAULT_TREATMENT_RATE,
    };
    lines.push(`[${metricKindLabel(m.kind)}] ${m.name}`);
    lines.push(`  checked: ${checked ? "yes" : "no"}`);
    lines.push(`  metric key: ${m.key}`);
    if (m.event_id != null) lines.push(`  event_id: ${m.event_id}`);
    if (m.event_type) lines.push(`  event_type: ${m.event_type}`);
    if (m.kind === "revenue") {
      lines.push(
        `  logx entity_id=${projectId.trim() || "—"} key=${WEB_REVENUE_EVENT_KEY} tags.revenue (integer cents)`,
      );
    } else if (m.event_id != null) {
      lines.push(`  ${describeLogxEvent(m)}`);
    }
    lines.push(`  control rate: ${rates.control}  treatment rate: ${rates.treatment}`);
    if (m.kind === "revenue") {
      lines.push(`  revenue per event (USD): ${revenuePerConversion}`);
    } else if (m.event_id != null) {
      const mTreatment = parseRate(rates.treatment, 0.85);
      const estTreat = Math.round(treatmentVisitors * mTreatment);
      lines.push(
        `  estimate: ~${Math.round(mTreatment * 100)}% treatment → ~${estTreat.toLocaleString()} unique conversions`,
      );
    }
    lines.push("");
  }

  lines.push(
    "Logx",
    "POST https://logx.optimizely.com/v1/events",
    "Each visitor snapshot: campaign_activated (type) + decision + conversion event(s)",
    "",
    "Validate in Optimizely",
    "Results → expand all metrics (Visited Page / Clicked on CTA are secondary, collapsed by default)",
    `Experiment results API: GET /v2/experiments/${experimentId.trim() || "{experiment_id}"}/results`,
  );

  return lines.join("\n");
}

function validationCheckClass(status: ValidationCheckStatus): string {
  switch (status) {
    case "pass":
      return "opt-check-pass";
    case "warn":
      return "opt-check-warn";
    case "fail":
      return "opt-check-fail";
  }
}

type Step7Tab = "metrics" | "demo" | "validation";

type DemoProjectProduct = "web" | "feature";

function NewProjectModal({
  open,
  name,
  product,
  createdProjectId,
  busy,
  error,
  message,
  onNameChange,
  onProductChange,
  onClose,
  onCreateProject,
  onCreateMetrics,
}: {
  open: boolean;
  name: string;
  product: DemoProjectProduct;
  createdProjectId: string | null;
  busy: "create" | "metrics" | null;
  error: string | null;
  message: string | null;
  onNameChange: (value: string) => void;
  onProductChange: (value: DemoProjectProduct) => void;
  onClose: () => void;
  onCreateProject: () => void;
  onCreateMetrics: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="opt-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-dialog-title"
      onClick={onClose}
    >
      <div className="opt-dialog space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h3 id="new-project-dialog-title" className="opt-dialog-title">
            Create new project
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="opt-btn-icon px-2 py-1 text-sm"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="opt-label">Project name</span>
          <input
            className="opt-input"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Demo – Results Showcase"
            autoComplete="off"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="opt-label">Product</span>
          <select
            className="opt-select"
            value={product}
            onChange={(e) => onProductChange(e.target.value as DemoProjectProduct)}
          >
            <option value="web">Web Experimentation</option>
            <option value="feature">Feature Experimentation</option>
          </select>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onCreateProject}
            disabled={busy !== null || !name.trim()}
            className="opt-btn-primary"
          >
            {busy === "create" ? "Creating…" : "Create project"}
          </button>
          <button
            type="button"
            onClick={onCreateMetrics}
            disabled={busy !== null || !createdProjectId}
            className="opt-btn-secondary"
          >
            {busy === "metrics" ? "Creating metrics…" : "Create metrics"}
          </button>
        </div>

        {createdProjectId && (
          <p className="opt-hint">
            Project ID: <code className="opt-code">{createdProjectId}</code>
          </p>
        )}
        {error && <p className="opt-text-warning">{error}</p>}
        {message && <p className="opt-text-success">{message}</p>}
      </div>
    </div>
  );
}

type DemoTestMetricToggles = {
  revenue: boolean;
  visitedPage: boolean;
  clickedCta: boolean;
};

function CreateNewTestModal({
  open,
  name,
  testKind,
  metrics,
  busy,
  error,
  message,
  onNameChange,
  onTestKindChange,
  onMetricsChange,
  onClose,
  onCreate,
}: {
  open: boolean;
  name: string;
  testKind: DemoTestKind;
  metrics: DemoTestMetricToggles;
  busy: boolean;
  error: string | null;
  message: string | null;
  onNameChange: (value: string) => void;
  onTestKindChange: (value: DemoTestKind) => void;
  onMetricsChange: (value: DemoTestMetricToggles) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  if (!open) return null;

  const canCreate =
    name.trim().length > 0 &&
    (metrics.revenue || metrics.visitedPage || metrics.clickedCta);

  return (
    <div
      className="opt-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-new-test-dialog-title"
      onClick={onClose}
    >
      <div className="opt-dialog space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h3 id="create-new-test-dialog-title" className="opt-dialog-title">
            Create new test
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="opt-btn-icon px-2 py-1 text-sm"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="opt-label">Test name</span>
          <input
            className="opt-input"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Homepage hero test"
            autoComplete="off"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="opt-label">Test type</span>
          <select
            className="opt-select"
            value={testKind}
            onChange={(e) => onTestKindChange(e.target.value as DemoTestKind)}
          >
            <option value="ab">A/B test</option>
            <option value="multiarmed_bandit">Multi-arm bandit</option>
            <option value="personalization">Personalisation campaign</option>
          </select>
        </label>

        <fieldset className="space-y-2 text-sm">
          <legend className="opt-label">Metrics</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={metrics.revenue}
              onChange={(e) => onMetricsChange({ ...metrics, revenue: e.target.checked })}
            />
            <span>Overall revenue</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={metrics.visitedPage}
              onChange={(e) => onMetricsChange({ ...metrics, visitedPage: e.target.checked })}
            />
            <span>Visited Page</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={metrics.clickedCta}
              onChange={(e) => onMetricsChange({ ...metrics, clickedCta: e.target.checked })}
            />
            <span>Clicked on CTA</span>
          </label>
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onCreate}
            disabled={busy || !canCreate}
            className="opt-btn-primary"
          >
            {busy ? "Creating…" : "Create test"}
          </button>
        </div>

        {error && <p className="opt-text-warning">{error}</p>}
        {message && <p className="opt-text-success">{message}</p>}
      </div>
    </div>
  );
}

function Step7TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={active ? "opt-tab-active" : "opt-tab"}
    >
      {label}
    </button>
  );
}

function CreateCustomMetricsButton({
  busy,
  onClick,
  className,
}: {
  busy: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={className}
    >
      {busy ? "Creating custom metrics…" : "Create custom metrics (Visited Page + Clicked on CTA Button)"}
    </button>
  );
}

export function FakeDataForm() {
  const savedRef = useRef(readSavedFormState());
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState(savedRef.current.picks.projectId);
  const [campaignId, setCampaignId] = useState(savedRef.current.picks.campaignId);
  const [experimentId, setExperimentId] = useState(savedRef.current.picks.experimentId);

  const [campaigns, setCampaigns] = useState<CampaignOption[]>(savedRef.current.cache.campaigns);
  const [experiments, setExperiments] = useState<NamedEntity[]>(savedRef.current.cache.experiments);
  const [manualIds, setManualIds] = useState(savedRef.current.picks.manualIds);
  const [revealToken, setRevealToken] = useState(false);
  const [projectExperiments, setProjectExperiments] = useState<NamedEntity[]>(
    savedRef.current.cache.projectExperiments,
  );
  const [afterDiscovery, setAfterDiscovery] = useState(savedRef.current.cache.afterDiscovery);
  const [pickerKind, setPickerKind] = useState<"campaign_chain" | "project_experiment" | null>(
    savedRef.current.cache.pickerKind,
  );
  const [discoveryMode, setDiscoveryMode] = useState<string | null>(
    savedRef.current.cache.discoveryMode,
  );

  const [visitorCount, setVisitorCount] = useState(savedRef.current.picks.visitorCount);
  const [revenuePerConversion, setRevenuePerConversion] = useState(
    savedRef.current.picks.revenuePerConversion,
  );
  const [trafficMode, setTrafficMode] = useState<TrafficMode>(savedRef.current.picks.trafficMode);
  const [trafficApplying, setTrafficApplying] = useState(false);
  const [trafficStatus, setTrafficStatus] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<LoadResult | null>(
    savedRef.current.cache.loaded as LoadResult | null,
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    new Set(savedRef.current.cache.selectedKeys),
  );
  const [metricRates, setMetricRates] = useState<Record<string, MetricRateFields>>(
    savedRef.current.cache.metricRates,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendLog, setSendLog] = useState<string[]>([]);
  const [previewMetricKey, setPreviewMetricKey] = useState<string | null>(null);
  const [previewPayload, setPreviewPayload] = useState<{
    batch: unknown;
    note: string;
  } | null>(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null);
  const [validationReport, setValidationReport] = useState<ExperimentValidationReport | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationLoading, setValidationLoading] = useState(false);
  const [step7Tab, setStep7Tab] = useState<Step7Tab>("metrics");
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectProduct, setNewProjectProduct] = useState<DemoProjectProduct>("web");
  const [createdNewProjectId, setCreatedNewProjectId] = useState<string | null>(null);
  const [newProjectBusy, setNewProjectBusy] = useState<"create" | "metrics" | null>(null);
  const [newProjectModalError, setNewProjectModalError] = useState<string | null>(null);
  const [newProjectModalMessage, setNewProjectModalMessage] = useState<string | null>(null);
  const [newTestModalOpen, setNewTestModalOpen] = useState(false);
  const [newTestName, setNewTestName] = useState("");
  const [newTestKind, setNewTestKind] = useState<DemoTestKind>("ab");
  const [newTestMetrics, setNewTestMetrics] = useState<DemoTestMetricToggles>({
    revenue: true,
    visitedPage: true,
    clickedCta: true,
  });
  const [newTestBusy, setNewTestBusy] = useState(false);
  const [newTestModalError, setNewTestModalError] = useState<string | null>(null);
  const [newTestModalMessage, setNewTestModalMessage] = useState<string | null>(null);
  const [experimentLiveStatus, setExperimentLiveStatus] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "campaigns" | "experiments" | "load" | "send" | "create-metrics" | null
  >(null);
  const [accountProjects, setAccountProjects] = useState<NamedEntity[]>(
    savedRef.current.cache.accountProjects,
  );
  const [projectListBusy, setProjectListBusy] = useState(false);
  const [projectListError, setProjectListError] = useState<string | null>(null);
  const lastAutoLoadedProject = useRef(
    savedRef.current.cache.accountProjects.length > 0 && savedRef.current.picks.projectId
      ? savedRef.current.picks.projectId
      : "",
  );
  const lastLoadedCampaign = useRef(
    savedRef.current.cache.experiments.length > 0 && savedRef.current.picks.campaignId
      ? savedRef.current.picks.campaignId
      : "",
  );
  const sendAbortRef = useRef<AbortController | null>(null);

  const resetAfterProjectIdChange = useCallback(() => {
    setCampaigns([]);
    setProjectExperiments([]);
    setExperiments([]);
    setCampaignId("");
    setExperimentId("");
    setLoaded(null);
    setAfterDiscovery(false);
    setPickerKind(null);
    setDiscoveryMode(null);
  }, []);

  const onProjectIdInput = useCallback(
    (value: string) => {
      setProjectId(value);
      if (!value.trim()) lastAutoLoadedProject.current = "";
      resetAfterProjectIdChange();
    },
    [resetAfterProjectIdChange],
  );

  const loadProjectList = useCallback(async () => {
    setProjectListError(null);
    setProjectListBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() || undefined }),
      });
      const raw = await res.text();
      let data: { projects?: NamedEntity[]; error?: string };
      try {
        data = raw.trim() ? (JSON.parse(raw) as typeof data) : {};
      } catch {
        throw new Error(
          res.ok
            ? "Invalid JSON from server"
            : `HTTP ${res.status}${raw.trim() ? `: ${raw.slice(0, 200)}` : " (empty response)"}`,
        );
      }
      if (!res.ok) {
        setProjectListError(data.error ?? `HTTP ${res.status}`);
        setAccountProjects([]);
        return;
      }
      const list = data.projects ?? [];
      setAccountProjects(list);
      const ids = new Set(list.map((p) => p.id));
      if (!ids.has(projectId.trim())) {
        resetAfterProjectIdChange();
        setProjectId("");
      }
    } catch (e) {
      setProjectListError(e instanceof Error ? e.message : "Request failed");
      setAccountProjects([]);
    } finally {
      setProjectListBusy(false);
    }
  }, [token, projectId, resetAfterProjectIdChange]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      writeSavedFormState({
        v: 1,
        picks: {
          projectId,
          campaignId,
          experimentId,
          manualIds,
          visitorCount,
          revenuePerConversion,
          trafficMode,
        },
        cache: {
          accountProjects,
          campaigns,
          projectExperiments,
          experiments,
          afterDiscovery,
          pickerKind,
          discoveryMode,
          loaded,
          selectedKeys: [...selectedKeys],
          metricRates,
        },
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [
    projectId,
    campaignId,
    experimentId,
    manualIds,
    visitorCount,
    revenuePerConversion,
    trafficMode,
    accountProjects,
    campaigns,
    projectExperiments,
    experiments,
    afterDiscovery,
    pickerKind,
    discoveryMode,
    loaded,
    selectedKeys,
    metricRates,
  ]);

  const clearSavedState = useCallback(() => {
    clearSavedFormState();
    lastAutoLoadedProject.current = "";
    lastLoadedCampaign.current = "";
    setProjectId("");
    setCampaignId("");
    setExperimentId("");
    setManualIds(false);
    setAccountProjects([]);
    setCampaigns([]);
    setProjectExperiments([]);
    setExperiments([]);
    setAfterDiscovery(false);
    setPickerKind(null);
    setDiscoveryMode(null);
    setLoaded(null);
    setSelectedKeys(new Set());
    setMetricRates({});
    setVisitorCount(EMPTY_PICKS.visitorCount);
    setRevenuePerConversion(EMPTY_PICKS.revenuePerConversion);
    setTrafficMode(EMPTY_PICKS.trafficMode);
    setLoadError(null);
    setSendLog([]);
    setProjectListError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/env-token")
      .then((r) => r.json())
      .then((d: { token?: string | null }) => {
        if (cancelled || !d?.token) return;
        setToken((prev) => (prev.trim() ? prev : d.token!));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMetric = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setMetricRateField = (key: string, field: keyof MetricRateFields, value: string) => {
    setMetricRates((prev) => {
      const current = prev[key] ?? {
        control: DEFAULT_CONTROL_RATE,
        treatment: DEFAULT_TREATMENT_RATE,
      };
      return {
        ...prev,
        [key]: { ...current, [field]: value },
      };
    });
  };

  const buildMetricsToFire = useCallback(
    (selected: Metric[]) => {
      return selected.map((m) => {
        const r = metricRates[m.key] ?? {
          control: DEFAULT_CONTROL_RATE,
          treatment: DEFAULT_TREATMENT_RATE,
        };
        return {
          ...m,
          controlConversionRate: parseRate(r.control, 0.2),
          treatmentConversionRate: parseRate(r.treatment, 0.85),
        };
      });
    },
    [metricRates],
  );

  const loadCampaigns = useCallback(async () => {
    setLoadError(null);
    setCampaigns([]);
    setProjectExperiments([]);
    setExperiments([]);
    setCampaignId("");
    setExperimentId("");
    setLoaded(null);
    setSendLog([]);
    setAfterDiscovery(false);
    setPickerKind(null);
    setDiscoveryMode(null);
    lastLoadedCampaign.current = "";
    setBusy("campaigns");
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          projectId: projectId.trim(),
        }),
      });
      const data = (await res.json()) as {
        campaigns?: CampaignOption[];
        projectExperiments?: NamedEntity[];
        mode?: string;
        error?: string;
      };
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const mode = data.mode ?? "empty";
      setDiscoveryMode(mode);
      setCampaigns(data.campaigns ?? []);
      setProjectExperiments(data.projectExperiments ?? []);
      setAfterDiscovery(true);

      if (mode === "experiments_first") {
        setPickerKind("project_experiment");
        setLoadError(
          (data.projectExperiments?.length ?? 0) > 0
            ? null
            : "No project experiments found. Use manual ID entry or check the project ID and token read scope.",
        );
        return;
      }
      if (mode === "empty") {
        setPickerKind("campaign_chain");
        setLoadError("No Web campaigns and no experiments for this project. Check project ID, token (Read scope), or use “Enter campaign & experiment IDs manually”.");
        return;
      }

      setPickerKind("campaign_chain");
      if ((data.campaigns?.length ?? 0) > 0) {
        setLoadError(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, [token, projectId]);

  useEffect(() => {
    if (manualIds) return;
    const id = projectId.trim();
    if (!id || !accountProjects.some((p) => p.id === id)) return;
    if (lastAutoLoadedProject.current === id) return;
    if (busy === "campaigns") return;
    lastAutoLoadedProject.current = id;
    void loadCampaigns();
  }, [projectId, accountProjects, manualIds, busy, loadCampaigns]);

  const loadExperimentsForCampaign = useCallback(
    async (cid: string) => {
      if (!cid.trim()) {
        setExperiments([]);
        setExperimentId("");
        return;
      }
      setBusy("experiments");
      setLoadError(null);
      try {
        const res = await fetch("/api/experiments-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: token.trim() || undefined,
            campaignId: cid.trim(),
          }),
        });
        const data = (await res.json()) as { experiments?: NamedEntity[]; error?: string };
        if (!res.ok) {
          setLoadError(data.error ?? `HTTP ${res.status}`);
          setExperiments([]);
          setExperimentId("");
          return;
        }
        const list = data.experiments ?? [];
        setExperiments(list);
        setExperimentId((current) =>
          current && list.some((e) => e.id === current) ? current : "",
        );
        if (!list.length) {
          setLoadError(
            "No experiments returned for this campaign. Pick another campaign or enter an experiment ID manually.",
          );
        } else {
          setLoadError(null);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Request failed");
        setExperiments([]);
        setExperimentId("");
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  const pickProjectExperiment = useCallback(
    async (experimentEid: string) => {
      if (!experimentEid.trim()) {
        setExperimentId("");
        setCampaignId("");
        return;
      }
      setExperimentId(experimentEid);
      setBusy("experiments");
      setLoadError(null);
      try {
        const res = await fetch("/api/experiment-peek", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: token.trim() || undefined,
            experimentId: experimentEid.trim(),
          }),
        });
        const data = (await res.json()) as { campaignId?: string | null; error?: string };
        if (!res.ok) {
          setLoadError(data.error ?? `HTTP ${res.status}`);
          setCampaignId("");
          return;
        }
        setCampaignId(data.campaignId?.trim() ?? "");
        if (!data.campaignId) {
          setLoadError(
            "This experiment has no campaign_id in the API. Paste the campaign ID from your Results URL, or use manual ID entry.",
          );
        } else {
          setLoadError(null);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Request failed");
        setCampaignId("");
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  useEffect(() => {
    if (manualIds) return;
    if (pickerKind === "project_experiment") return;
    const cid = campaignId.trim();
    if (!cid) {
      setExperiments([]);
      setExperimentId("");
      lastLoadedCampaign.current = "";
      return;
    }
    if (lastLoadedCampaign.current === cid && experiments.some((e) => e.id)) return;
    lastLoadedCampaign.current = cid;
    void loadExperimentsForCampaign(cid);
  }, [campaignId, manualIds, loadExperimentsForCampaign, pickerKind, experiments]);

  const loadExperimentDetails = useCallback(async (opts?: { soft?: boolean }) => {
    const soft = opts?.soft ?? false;
    setLoadError(null);
    if (!soft) {
      setLoaded(null);
      setSendLog([]);
    }
    setBusy(soft ? "create-metrics" : "load");
    try {
      const res = await fetch("/api/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          projectId: projectId.trim(),
          experimentId: experimentId.trim(),
        }),
      });
      const data = (await res.json()) as LoadResult & { error?: string };
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setLoaded({
        accountId: data.accountId,
        codeRevision: data.codeRevision,
        experimentStartTime: data.experimentStartTime,
        variations: data.variations,
        metrics: data.metrics,
      });
      setSelectedKeys(new Set(data.metrics.map((m) => m.key)));
      setMetricRates(seedAllMetricRates(data.metrics));
      if (!data.metrics.length) {
        setLoadError("No metrics resolved for this experiment (no revenue sum or event-backed metrics).");
      } else {
        setLoadError(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, [token, projectId, experimentId]);

  const toggleTrafficToVariation = useCallback(async () => {
    if (!loaded || !experimentId.trim()) return;
    const nextMode: TrafficMode =
      trafficMode === "all_treatment" ? "balanced" : "all_treatment";
    setTrafficApplying(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/traffic-to-variation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          experimentId: experimentId.trim(),
          mode: nextMode,
          variations: loaded.variations,
        }),
      });
      const data = (await res.json()) as { summary?: string; error?: string };
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setTrafficMode(nextMode);
      setTrafficStatus(data.summary ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setTrafficApplying(false);
    }
  }, [loaded, experimentId, trafficMode, token]);

  const refreshExperimentStatus = useCallback(async () => {
    if (!experimentId.trim()) return;
    try {
      const res = await fetch("/api/experiment-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          experimentId: experimentId.trim(),
        }),
      });
      const data = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) {
        setExperimentLiveStatus(null);
        return;
      }
      setExperimentLiveStatus(data.status ?? null);
    } catch {
      setExperimentLiveStatus(null);
    }
  }, [experimentId, token]);

  useEffect(() => {
    if (step7Tab !== "demo" || !experimentId.trim()) return;
    void refreshExperimentStatus();
  }, [step7Tab, experimentId, refreshExperimentStatus]);

  const runExperimentLifecycle = useCallback(
    async (action: "start" | "pause") => {
      if (!experimentId.trim()) return;
      setLifecycleBusy(true);
      setLifecycleMessage(null);
      setLoadError(null);
      try {
        const res = await fetch("/api/experiment-lifecycle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: token.trim() || undefined,
            experimentId: experimentId.trim(),
            action,
          }),
        });
        const data = (await res.json()) as { status?: string; error?: string };
        if (!res.ok) {
          setLoadError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setExperimentLiveStatus(data.status ?? null);
        setLifecycleMessage(
          action === "start"
            ? `Experiment started (status=${data.status ?? "running"}).`
            : `Experiment paused (status=${data.status ?? "paused"}).`,
        );
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setLifecycleBusy(false);
      }
    },
    [experimentId, token],
  );

  const openNewProjectModal = useCallback(() => {
    setNewProjectModalOpen(true);
    setNewProjectModalError(null);
  }, []);

  const closeNewProjectModal = useCallback(() => {
    setNewProjectModalOpen(false);
  }, []);

  const createNewProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectModalError("Project name is required.");
      return;
    }
    setNewProjectBusy("create");
    setNewProjectModalError(null);
    setNewProjectModalMessage(null);
    try {
      const res = await fetch("/api/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          name,
          product: newProjectProduct,
        }),
      });
      const data = (await res.json()) as {
        projectId?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok) {
        setNewProjectModalError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const id = data.projectId ?? "";
      const displayName = data.name ?? name;
      setCreatedNewProjectId(id);
      setProjectId(id);
      setAccountProjects((prev) => {
        const filtered = prev.filter((p) => p.id !== id);
        filtered.push({ id, name: displayName });
        filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        return filtered;
      });
      setNewProjectModalMessage(`Created project “${displayName}” (ID ${id}). Selected in step 1.`);
    } catch (e) {
      setNewProjectModalError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setNewProjectBusy(null);
    }
  }, [newProjectName, newProjectProduct, token]);

  const createNewProjectMetrics = useCallback(async () => {
    const pid = createdNewProjectId?.trim();
    if (!pid) {
      setNewProjectModalError("Create a project first.");
      return;
    }
    setNewProjectBusy("metrics");
    setNewProjectModalError(null);
    try {
      const res = await fetch("/api/create-project-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          projectId: pid,
        }),
      });
      const data = (await res.json()) as {
        created?: string[];
        existing?: string[];
        error?: string;
      };
      if (!res.ok) {
        setNewProjectModalError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const parts: string[] = [];
      if (data.created?.length) parts.push(`Created: ${data.created.join(", ")}`);
      if (data.existing?.length) parts.push(`Already existed: ${data.existing.join(", ")}`);
      setNewProjectModalMessage(parts.join(" · ") || "Starter custom events are on the project.");
    } catch (e) {
      setNewProjectModalError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setNewProjectBusy(null);
    }
  }, [createdNewProjectId, token]);

  const openNewTestModal = useCallback(() => {
    if (!projectId.trim()) {
      setLoadError("Select a project first.");
      return;
    }
    setNewTestModalOpen(true);
    setNewTestModalError(null);
    setNewTestModalMessage(null);
  }, [projectId]);

  const closeNewTestModal = useCallback(() => {
    setNewTestModalOpen(false);
  }, []);

  const createNewTest = useCallback(async () => {
    const name = newTestName.trim();
    if (!name) {
      setNewTestModalError("Test name is required.");
      return;
    }
    if (!projectId.trim()) {
      setNewTestModalError("Select a project first.");
      return;
    }
    if (!newTestMetrics.revenue && !newTestMetrics.visitedPage && !newTestMetrics.clickedCta) {
      setNewTestModalError("Select at least one metric.");
      return;
    }

    setNewTestBusy(true);
    setNewTestModalError(null);
    setNewTestModalMessage(null);
    try {
      const res = await fetch("/api/create-demo-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          projectId: projectId.trim(),
          name,
          testKind: newTestKind,
          metrics: newTestMetrics,
        }),
      });
      const data = (await res.json()) as {
        campaignId?: string;
        experimentId?: string;
        experimentName?: string;
        metricsAttached?: string[];
        error?: string;
      };
      if (!res.ok) {
        setNewTestModalError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      const cid = data.campaignId ?? "";
      const eid = data.experimentId ?? "";
      const displayName = data.experimentName ?? name;

      setAfterDiscovery(true);
      setPickerKind("campaign_chain");
      setCampaigns((prev) => {
        const filtered = prev.filter((c) => c.id !== cid);
        filtered.push({
          id: cid,
          name: displayName,
          ...(newTestKind === "personalization" ? { type: "personalization" } : {}),
        });
        filtered.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        return filtered;
      });
      setExperiments((prev) => {
        const filtered = prev.filter((e) => e.id !== eid);
        filtered.push({ id: eid, name: displayName });
        filtered.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        return filtered;
      });
      lastLoadedCampaign.current = cid;
      setCampaignId(cid);
      setExperimentId(eid);
      setLoadError(null);

      const metricNote =
        data.metricsAttached?.length ? ` Metrics: ${data.metricsAttached.join(", ")}.` : "";
      setNewTestModalMessage(
        `Created “${displayName}” (campaign ${cid}, experiment ${eid}).${metricNote}`,
      );
    } catch (e) {
      setNewTestModalError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setNewTestBusy(false);
    }
  }, [newTestName, newTestKind, newTestMetrics, projectId, token]);

  const createStarterMetrics = useCallback(async () => {
    if (!experimentId.trim() || !projectId.trim()) return;
    setLoadError(null);
    setBusy("create-metrics");
    try {
      const res = await fetch("/api/create-starter-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          projectId: projectId.trim(),
          experimentId: experimentId.trim(),
        }),
      });
      const data = (await res.json()) as {
        created?: string[];
        attached?: string[];
        error?: string;
      };
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await loadExperimentDetails({ soft: true });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, [token, projectId, campaignId, experimentId, manualIds, loadExperimentDetails]);

  const previewMetricLogx = useCallback(
    async (metric: Metric) => {
      if (!loaded || !campaignId.trim()) return;
      if (previewMetricKey === metric.key) {
        setPreviewMetricKey(null);
        setPreviewPayload(null);
        return;
      }

      setPreviewLoadingKey(metric.key);
      setPreviewMetricKey(metric.key);
      setPreviewPayload(null);

      const [metricToFire] = buildMetricsToFire([metric]);
      const companionConversion = loaded.metrics
        .filter(isConversionMetric)
        .find((m) => selectedKeys.has(m.key));
      const companion =
        metric.kind === "revenue" && companionConversion
          ? buildMetricsToFire([companionConversion])[0]
          : undefined;
      const personalizationCampaign =
        campaigns.find((c) => c.id === campaignId.trim())?.type?.toLowerCase() === "personalization";

      try {
        const res = await fetch("/api/preview-logx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: loaded.accountId,
            projectId: projectId.trim(),
            campaignId: campaignId.trim(),
            experimentId: experimentId.trim(),
            codeRevision: loaded.codeRevision,
            variations: loaded.variations,
            metric: metricToFire,
            companionConversion: companion,
            revenuePerConversionDollars: Math.max(0, Number(revenuePerConversion) || 0),
            trafficMode,
            personalizationCampaign,
          }),
        });
        const data = (await res.json()) as {
          batch?: unknown;
          note?: string;
          error?: string;
        };
        if (!res.ok) {
          setPreviewPayload({
            batch: { error: data.error ?? `HTTP ${res.status}` },
            note: "",
          });
          return;
        }
        setPreviewPayload({
          batch: data.batch,
          note: data.note ?? "",
        });
      } catch (e) {
        setPreviewPayload({
          batch: { error: e instanceof Error ? e.message : "Request failed" },
          note: "",
        });
      } finally {
        setPreviewLoadingKey(null);
      }
    },
    [
      loaded,
      campaignId,
      projectId,
      experimentId,
      buildMetricsToFire,
      selectedKeys,
      revenuePerConversion,
      trafficMode,
      campaigns,
      previewMetricKey,
    ],
  );

  const runValidationSetup = useCallback(async () => {
    if (!experimentId.trim() || !loaded) return;
    setValidationLoading(true);
    setValidationError(null);
    try {
      const res = await fetch("/api/validate-experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim() || undefined,
          experimentId: experimentId.trim(),
          metrics: loaded.metrics,
        }),
      });
      const data = (await res.json()) as ExperimentValidationReport & { error?: string };
      if (!res.ok) {
        setValidationError(data.error ?? `HTTP ${res.status}`);
        setValidationReport(null);
        return;
      }
      setValidationReport(data);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : "Request failed");
      setValidationReport(null);
    } finally {
      setValidationLoading(false);
    }
  }, [experimentId, token, loaded]);

  const cancelSendEvents = useCallback(() => {
    sendAbortRef.current?.abort();
  }, []);

  const sendEvents = useCallback(async () => {
    if (!loaded) return;
    const total = Math.max(1, Math.floor(Number(visitorCount) || 0));
    const selected = loaded.metrics.filter((m) => selectedKeys.has(m.key));
    const wantsRevenue = selected.some((m) => m.kind === "revenue");
    const metricsToFire = buildMetricsToFire(selected);
    if (loaded.metrics.length > 0 && metricsToFire.length === 0) {
      setSendLog(["Select at least one metric checkbox above."]);
      return;
    }
    const revenueDollars = Math.max(0, Number(revenuePerConversion) || 0);
    if (!campaignId.trim()) {
      setSendLog(["Campaign ID is required to build activation events."]);
      return;
    }

    setBusy("send");
    sendAbortRef.current?.abort();
    const sendAbort = new AbortController();
    sendAbortRef.current = sendAbort;
    const lines: string[] = [];
    let sent = 0;
    const batches = Math.ceil(total / BATCH_SIZE);
    const timestampEndMs = Date.now();
    const timestampStartMs = loaded.experimentStartTime
      ? new Date(loaded.experimentStartTime).getTime()
      : timestampEndMs - 30 * 24 * 60 * 60 * 1000;
    const startLabel = new Date(timestampStartMs).toLocaleString();
    const endLabel = new Date(timestampEndMs).toLocaleString();
    lines.push(
      loaded.experimentStartTime
        ? `Event timestamps staggered ${startLabel} → ${endLabel} (from Results start_time).`
        : `Event timestamps staggered ${startLabel} → ${endLabel} (no Results start_time — using last 30 days).`,
    );
    setSendLog([...lines]);
    const finishSend = () => {
      setBusy(null);
      sendAbortRef.current = null;
    };
    const logCancelled = () => {
      lines.push(`Cancelled. Sent ${sent.toLocaleString()}/${total.toLocaleString()} visitors before stop.`);
      setSendLog([...lines]);
      finishSend();
    };
    const personalizationCampaign =
      campaigns.find((c) => c.id === campaignId.trim())?.type?.toLowerCase() === "personalization";

    for (let b = 0; b < batches; b++) {
      if (sendAbort.signal.aborted) {
        logCancelled();
        return;
      }
      const count = Math.min(BATCH_SIZE, total - sent);
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: sendAbort.signal,
          body: JSON.stringify({
            accountId: loaded.accountId,
            projectId: projectId.trim(),
            campaignId: campaignId.trim(),
            experimentId: experimentId.trim(),
            codeRevision: loaded.codeRevision,
            personalizationCampaign,
            variations: loaded.variations,
            metricsToFire,
            count,
            totalVisitorCount: total,
            visitorIndexOffset: sent,
            timestampStartMs,
            timestampEndMs,
            revenuePerConversionDollars: revenueDollars,
            trafficMode,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          sent?: number;
          logxStatus?: number;
          error?: string;
          detail?: string;
        };
        if (!res.ok) {
          lines.push(
            `[${b + 1}/${batches}] Failed: ${data.error ?? res.status}` +
              (data.detail ? ` — ${data.detail.slice(0, 200)}` : ""),
          );
          setSendLog(lines);
          finishSend();
          return;
        }
        sent += data.sent ?? count;
        lines.push(
          `[${b + 1}/${batches}] Sent ${data.sent} visitors (${sent}/${total}) → logx HTTP ${data.logxStatus ?? "?"}`,
        );
        setSendLog([...lines]);
      } catch (e) {
        if (isAbortError(e)) {
          logCancelled();
          return;
        }
        lines.push(`[${b + 1}/${batches}] ${e instanceof Error ? e.message : "Network error"}`);
        setSendLog(lines);
        finishSend();
        return;
      }
      if (b + 1 < batches) {
        try {
          await delayMs(BATCH_DELAY_MS, sendAbort.signal);
        } catch (e) {
          if (isAbortError(e)) {
            logCancelled();
            return;
          }
          throw e;
        }
      }
    }

    if (sendAbort.signal.aborted) {
      logCancelled();
      return;
    }

    const eventCount = metricsToFire.filter((m) => m.kind !== "revenue").length;
    const revenueOnly = wantsRevenue && eventCount === 0;
    const { control, treatment } = resolveControlTreatment(loaded.variations);
    const trafficNote =
      trafficMode === "all_treatment"
        ? `100% traffic to ${treatment.name} (0% ${control.name} and other variations).`
        : `50/50 traffic — per-metric control/treatment rates applied (${control.name} vs ${treatment.name}).`;
    const expectedConvRate =
      eventCount > 0 || wantsRevenue ? trafficNote : "activations only (no conversion events)";
    const revenueNote = wantsRevenue
        ? revenueOnly
        ? ` Revenue $${revenueDollars.toLocaleString()} via separate trackRevenue for converting visitors.`
        : ` Revenue $${revenueDollars.toLocaleString()} via separate trackRevenue when a conversion event fires.`
      : "";
    lines.push(
      `Done. Sent ${sent} visitor(s) in ${batches} batch(es). ${expectedConvRate}.${revenueNote}`,
      "Results usually update in 1–5 minutes. With 100k visitors this spread typically reaches statistical significance on the primary metric.",
    );
    setSendLog(lines);
    finishSend();
  }, [
    loaded,
    visitorCount,
    revenuePerConversion,
    buildMetricsToFire,
    selectedKeys,
    campaignId,
    projectId,
    experimentId,
    campaigns,
    trafficMode,
  ]);

  const projectSelectedFromList = accountProjects.some((p) => p.id === projectId.trim());
  const canLoadCampaigns = projectSelectedFromList && busy === null;
  const canLoadDetails =
    busy === null && projectSelectedFromList && experimentId.trim().length > 0;

  const selectedCampaignRow = campaigns.find((c) => c.id === campaignId);
  const selectedCampaignType = selectedCampaignRow?.type?.toLowerCase() ?? "";
  const isPersonalizationCampaign = selectedCampaignType === "personalization";
  const step5IsExperiences = Boolean(campaignId.trim()) && isPersonalizationCampaign;
  const metricsToSend = loaded
    ? loaded.metrics.filter((m) => selectedKeys.has(m.key))
    : [];
  const conversionMetrics = loaded?.metrics.filter(isConversionMetric) ?? [];
  const customConversionMetrics = conversionMetrics.filter((m) => m.kind === "custom");
  const needsCustomMetrics = loaded != null && customConversionMetrics.length === 0;
  const selectableMetrics = loaded
    ? loaded.metrics.filter((m) => m.kind === "revenue" || isConversionMetric(m))
    : [];
  const controlTreatment =
    loaded && loaded.variations.length > 0
      ? resolveControlTreatment(loaded.variations)
      : null;
  const totalVisitors = Math.max(0, Math.floor(Number(visitorCount) || 0));
  const treatmentVisitors =
    trafficMode === "all_treatment" ? totalVisitors : Math.floor(totalVisitors / 2);

  const copyValidationDetails = useCallback(async () => {
    if (!loaded) return;
    const text = buildValidationClipboardText({
      loaded,
      projectId,
      campaignId,
      experimentId,
      trafficMode,
      visitorCount,
      revenuePerConversion,
      selectedKeys,
      metricRates,
      controlTreatment,
      treatmentVisitors,
      totalVisitors,
    });
    await navigator.clipboard.writeText(text);
  }, [
    loaded,
    projectId,
    campaignId,
    experimentId,
    trafficMode,
    visitorCount,
    revenuePerConversion,
    selectedKeys,
    metricRates,
    controlTreatment,
    treatmentVisitors,
    totalVisitors,
  ]);

  const sendDisabledReason = (() => {
    if (busy && busy !== "send") return "Wait for the current step to finish loading.";
    if (busy === "send") return "Populating…";
    if (!loaded) return 'Click "Load experiment details (metrics)" above first.';
    if (!campaignId.trim()) return "Campaign ID is missing — select step 3 or paste from your Results URL.";
    if (!experimentId.trim()) return "Select an experiment in step 4.";
    if (!loaded.variations.length) return "No variations returned for this experiment.";
    if (loaded.metrics.length > 0 && metricsToSend.length === 0) {
      return "Select at least one metric checkbox above.";
    }
    if (
      conversionMetrics.length > 0 &&
      !conversionMetrics.some((m) => selectedKeys.has(m.key))
    ) {
      return `Check a conversion metric (e.g. ${conversionMetrics[0]?.name ?? "Booking Page"}) — revenue alone does not count unique conversions on pageview/click goals.`;
    }
    return null;
  })();

  return (
    <div className="opt-page">
      <header>
        <h1 className="opt-page-title">Experimentation Data Helper</h1>
        <p className="opt-page-subtitle">
          Load experiments and send demo visitor data to logx for Results-page testing.
        </p>
      </header>

      <section className="opt-card space-y-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="opt-label">1. Optimizely API token</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setRevealToken((r) => !r)}
              className="opt-btn-icon absolute left-1.5 top-1/2 z-10 size-9 -translate-y-1/2"
              aria-label={revealToken ? "Hide API token" : "Show API token"}
              aria-pressed={revealToken}
            >
              <TokenVisibilityIcon visible={revealToken} />
            </button>
            <input
              type={revealToken ? "text" : "password"}
              className="opt-input py-2 pl-11 pr-3"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Optimizely API token"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span className="opt-label">2. Project</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadProjectList()}
              disabled={projectListBusy}
              className="opt-btn-muted"
            >
              {projectListBusy ? "Loading projects…" : "Load project list"}
            </button>
            <button
              type="button"
              onClick={openNewProjectModal}
              disabled={busy !== null}
              className="opt-btn-secondary"
            >
              New project
            </button>
            <button
              type="button"
              onClick={clearSavedState}
              disabled={busy !== null}
              className="opt-btn-secondary"
            >
              Clear saved picks
            </button>
            {accountProjects.length > 0 && (
              <span className="opt-hint">{accountProjects.length} project(s) loaded</span>
            )}
          </div>
          {projectListError && (
            <p className="opt-alert-error">{projectListError}</p>
          )}
          <label className="flex flex-col gap-1">
            <span className="opt-hint">Choose a project</span>
            <select
              className="opt-select"
              disabled={accountProjects.length === 0}
              value={accountProjects.some((p) => p.id === projectId) ? projectId : ""}
              onChange={(e) => onProjectIdInput(e.target.value)}
            >
              <option value="">
                {accountProjects.length === 0 ? "Load project list first…" : "Select a project…"}
              </option>
              {accountProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name.length > 80 ? `${p.name.slice(0, 77)}…` : p.name} ({p.id})
                </option>
              ))}
            </select>
          </label>
          {projectId.trim() && accountProjects.some((p) => p.id === projectId.trim()) && (
            <p className="opt-hint">
              {busy === "campaigns"
                ? "Loading campaigns and experiments for this project…"
                : afterDiscovery
                  ? `Project selected (${projectId})`
                  : "Project selected — loading campaigns…"}
            </p>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--opt-text-primary)]">
          <input
            type="checkbox"
            checked={manualIds}
            onChange={(e) => {
              const on = e.target.checked;
              setManualIds(on);
              setCampaigns([]);
              setProjectExperiments([]);
              setExperiments([]);
              setCampaignId("");
              setExperimentId("");
              setLoaded(null);
              setAfterDiscovery(false);
              setPickerKind(null);
              setDiscoveryMode(null);
              setLoadError(null);
            }}
          />
          Enter campaign &amp; experiment IDs manually (skip API lists)
        </label>

        {!manualIds && (
          <>
            <button
              type="button"
              onClick={() => void loadCampaigns()}
              disabled={!canLoadCampaigns}
              className="opt-btn-primary"
            >
              {busy === "campaigns" ? "Loading…" : "Load campaigns and experiments"}
            </button>

            {afterDiscovery && discoveryMode === "inferred_from_experiments" && campaigns.length > 0 && (
              <p className="opt-alert-info">
                Campaign list for this project was built from your experiments. Pick a campaign and an experiment
                as usual.
              </p>
            )}

            {afterDiscovery && pickerKind === "project_experiment" && projectExperiments.length > 0 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="opt-label">4. Experiment</span>
                <span className="opt-hint">
                  No top-level Web campaigns; choose an experiment and we will resolve the campaign for logx.
                </span>
                <select
                  className="opt-select"
                  value={experimentId}
                  onChange={(e) => void pickProjectExperiment(e.target.value)}
                  disabled={busy === "experiments" || busy === "campaigns"}
                >
                  <option value="">
                    {busy === "experiments" ? "Resolving campaign…" : "Select an experiment…"}
                  </option>
                  {projectExperiments.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.name.length > 70 ? `${ex.name.slice(0, 67)}…` : ex.name} ({ex.id})
                    </option>
                  ))}
                </select>
                {Boolean(campaignId) && (
                  <p className="opt-hint">
                    Campaign ID from API:{" "}
                    <code className="opt-code">{campaignId}</code>
                  </p>
                )}
                {!campaignId && Boolean(experimentId) && (
                  <div className="mt-1 flex flex-col gap-1 opt-hint">
                    <span>Campaign ID (from your Results page — needed for logx if the API has no campaign_id)</span>
                    <input
                      className="opt-input text-sm"
                      value={campaignId}
                      onChange={(e) => setCampaignId(e.target.value)}
                      placeholder="Paste from /results/… in the URL"
                      autoComplete="off"
                    />
                  </div>
                )}
              </label>
            )}

            {afterDiscovery && pickerKind === "campaign_chain" && (
              <>
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="opt-label">3. Experiments &amp; Personalisation Campaigns</span>
                    <button
                      type="button"
                      onClick={openNewTestModal}
                      disabled={busy !== null || newTestBusy || !projectId.trim()}
                      className="opt-btn-secondary"
                    >
                      Create new test
                    </button>
                  </div>
                  <select
                    className="opt-select"
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    disabled={campaigns.length === 0 || busy === "campaigns" || busy === "experiments"}
                  >
                    <option value="">{campaigns.length ? "Select a campaign…" : "No campaigns — use manual mode"}</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name.length > 70 ? `${c.name.slice(0, 67)}…` : c.name} ({c.id})
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="opt-label">
                    {step5IsExperiences ? "4. Personalisation campaign experiences" : "4. Experiment"}
                  </span>
                  {(!campaignId.trim() || step5IsExperiences) && (
                    <span className="opt-hint">
                      {!campaignId.trim()
                        ? "Select a campaign in step 3 first."
                        : "Experiences under this personalisation campaign."}
                    </span>
                  )}
                  <select
                    className="opt-select"
                    value={experimentId}
                    onChange={(e) => setExperimentId(e.target.value)}
                    disabled={
                      !campaignId.trim() ||
                      busy === "experiments" ||
                      busy === "campaigns" ||
                      experiments.length === 0
                    }
                  >
                    <option value="">
                      {busy === "experiments" ? "Loading experiments…" : "Select an experiment…"}
                    </option>
                    {experiments.map((ex) => (
                      <option key={ex.id} value={ex.id}>
                        {ex.name.length > 70 ? `${ex.name.slice(0, 67)}…` : ex.name} ({ex.id})
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </>
        )}

        {manualIds && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="opt-label">Campaign ID</span>
              <span className="opt-hint">Number after /results/</span>
              <input
                className="opt-select"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                placeholder="9300002367830"
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="opt-label">Experiment ID</span>
              <span className="opt-hint">Number after /experiments/</span>
              <input
                className="opt-select"
                value={experimentId}
                onChange={(e) => setExperimentId(e.target.value)}
                placeholder="9300003116092"
                autoComplete="off"
              />
            </label>
          </div>
        )}

        <button
          type="button"
          onClick={() => void loadExperimentDetails()}
          disabled={!canLoadDetails}
          className="opt-btn-primary"
        >
          {busy === "load" ? "Loading…" : "Load experiment details (metrics)"}
        </button>
        {loadError && (
          <div className="opt-alert-warning space-y-2">
            <p>{loadError}</p>
            {loadError.includes("No metrics resolved") && (
              <CreateCustomMetricsButton
                busy={busy !== null}
                onClick={() => void createStarterMetrics()}
                className="opt-btn-primary text-xs"
              />
            )}
          </div>
        )}
      </section>

      {loaded && (
        <section className="opt-card space-y-4">
          <h2 className="opt-section-title">Experiment Settings</h2>
          <p className="opt-hint">
            Account ID: <code className="opt-code">{loaded.accountId}</code>
            {" · "}
            Campaign: <code className="opt-code text-xs">{campaignId || "—"}</code>
            {" · "}
            Experiment:{" "}
            <code className="opt-code text-xs">{experimentId || "—"}</code>
          </p>

          <div className="opt-tab-list" role="tablist" aria-label="Experiment settings sections">
            <Step7TabButton
              active={step7Tab === "metrics"}
              label="Metrics"
              onClick={() => setStep7Tab("metrics")}
            />
            <Step7TabButton
              active={step7Tab === "demo"}
              label="Traffic Allocation"
              onClick={() => setStep7Tab("demo")}
            />
            <Step7TabButton
              active={step7Tab === "validation"}
              label="Validation"
              onClick={() => setStep7Tab("validation")}
            />
          </div>

          {step7Tab === "metrics" && (
            <div className="space-y-4 pt-4">
              <div>
                <p className="opt-label mb-2">Variations</p>
                <ul className="opt-body-text list-inside list-disc">
                  {loaded.variations.map((v) => {
                    const role =
                      controlTreatment?.control.variation_id === v.variation_id
                        ? "control"
                        : controlTreatment?.treatment.variation_id === v.variation_id
                          ? "treatment"
                          : "not used in A/B sim";
                    return (
                      <li key={v.variation_id}>
                        {v.name}{" "}
                        <span className="opt-hint">
                          (<code className="text-xs">{v.variation_id}</code>) — {role}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <p className="opt-label mb-2">Metrics</p>
                {needsCustomMetrics && (
                  <div className="opt-dashed-panel mb-3 w-full space-y-2">
                    <p className="opt-body-text text-[var(--opt-text-secondary)]">
                      No custom conversion metrics on this experiment yet.
                    </p>
                    <CreateCustomMetricsButton
                      busy={busy !== null}
                      onClick={() => void createStarterMetrics()}
                      className="opt-btn-secondary"
                    />
                  </div>
                )}
                {selectableMetrics.length === 0 && !needsCustomMetrics ? (
                  <p className="opt-body-text text-[var(--opt-text-secondary)]">
                    No event-backed conversion metrics — send{" "}
                    <code className="opt-code text-xs">campaign_activated</code> only.
                  </p>
                ) : selectableMetrics.length > 0 ? (
                  <ul className="space-y-3">
                    {selectableMetrics.map((m) => {
                      const rates = metricRates[m.key] ?? {
                        control: DEFAULT_CONTROL_RATE,
                        treatment: DEFAULT_TREATMENT_RATE,
                      };
                      const mTreatment = parseRate(rates.treatment, 0.85);
                      const estTreat = Math.round(treatmentVisitors * mTreatment);
                      const checked = selectedKeys.has(m.key);
                      const isRevenue = m.kind === "revenue";
                      return (
                        <li
                          key={m.key}
                          className={checked ? "opt-metric-row" : "opt-metric-row-muted"}
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <label className="flex min-w-0 cursor-pointer items-start gap-2">
                              <input
                                type="checkbox"
                                className="mt-1 shrink-0"
                                checked={checked}
                                onChange={() => toggleMetric(m.key)}
                              />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span
                                    className={
                                      "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                                      metricKindBadgeClass(m.kind)
                                    }
                                  >
                                    {metricKindLabel(m.kind)}
                                  </span>
                                  <span className="font-medium">{m.name}</span>
                                </span>
                                <span className="opt-hint">
                                  {isRevenue ? (
                                    <>
                                      logx entity_id={projectId.trim() || "—"} key={WEB_REVENUE_EVENT_KEY} ·
                                      tags.revenue (integer cents)
                                    </>
                                  ) : (
                                    <>
                                      <code className="opt-code text-[11px]">
                                        {m.key}
                                      </code>
                                      {m.event_id != null && <> · event_id {m.event_id}</>}
                                      {` · ${describeLogxEvent(m)}`}
                                    </>
                                  )}
                                </span>
                                <span className="opt-hint">
                                  {isRevenue ? (
                                    conversionMetrics.length === 0 ? (
                                      <>
                                        ~{Math.round(mTreatment * 100)}% treatment → ~{estTreat.toLocaleString()}{" "}
                                        revenue events at {totalVisitors.toLocaleString()} visitors.
                                      </>
                                    ) : (
                                      <>
                                        One revenue event per visitor with any checked conversion · $
                                        {Math.max(0, Number(revenuePerConversion) || 0).toLocaleString()} per event
                                      </>
                                    )
                                  ) : (
                                    <>
                                      ~{Math.round(mTreatment * 100)}% treatment → ~{estTreat.toLocaleString()} unique
                                      conversions at {totalVisitors.toLocaleString()} visitors.
                                    </>
                                  )}
                                </span>
                              </span>
                            </label>
                            <div className="flex shrink-0 flex-wrap gap-2 sm:pl-2">
                              <label className="flex flex-col gap-0.5 text-xs">
                                <span className="opt-hint font-medium">Control rate</span>
                                <input
                                  className="opt-input w-20 px-2 py-1.5"
                                  value={rates.control}
                                  onChange={(e) => setMetricRateField(m.key, "control", e.target.value)}
                                  inputMode="decimal"
                                  disabled={!checked}
                                  aria-label={`${m.name} control rate`}
                                />
                              </label>
                              <label className="flex flex-col gap-0.5 text-xs">
                                <span className="opt-hint font-medium">Treatment rate</span>
                                <input
                                  className="opt-input w-20 px-2 py-1.5"
                                  value={rates.treatment}
                                  onChange={(e) => setMetricRateField(m.key, "treatment", e.target.value)}
                                  inputMode="decimal"
                                  disabled={!checked}
                                  aria-label={`${m.name} treatment rate`}
                                />
                              </label>
                              {isRevenue && (
                                <label className="flex flex-col gap-0.5 text-xs sm:min-w-[10rem]">
                                  <span className="opt-hint font-medium">
                                    Revenue per event (USD)
                                  </span>
                                  <input
                                    className="opt-input w-full px-2 py-1.5 sm:w-36"
                                    value={revenuePerConversion}
                                    onChange={(e) => setRevenuePerConversion(e.target.value)}
                                    inputMode="numeric"
                                    disabled={!checked}
                                  />
                                </label>
                              )}
                              <button
                                type="button"
                                onClick={() => void previewMetricLogx(m)}
                                disabled={!campaignId.trim() || previewLoadingKey === m.key}
                                className="opt-btn-secondary self-end px-2.5 py-1.5 text-xs"
                              >
                                {previewLoadingKey === m.key
                                  ? "Loading…"
                                  : previewMetricKey === m.key
                                    ? "Hide logx preview"
                                    : "Preview logx"}
                              </button>
                            </div>
                          </div>
                          {previewMetricKey === m.key && (
                            <div className="mt-3 space-y-1.5 border-t border-[var(--opt-border-default)] pt-3">
                              {previewLoadingKey === m.key ? (
                                <p className="opt-hint">Building sample payload…</p>
                              ) : previewPayload ? (
                                <>
                                  {previewPayload.note && (
                                    <p className="opt-hint">{previewPayload.note}</p>
                                  )}
                                  <pre className="opt-log-dark max-h-64 text-[11px] leading-relaxed">
                                    {JSON.stringify(previewPayload.batch, null, 2)}
                                  </pre>
                                </>
                              ) : null}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>

              <div className="opt-divider">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="opt-label">Visitors to simulate</span>
                  <input
                    className="opt-input sm:max-w-xs"
                    value={visitorCount}
                    onChange={(e) => setVisitorCount(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void sendEvents()}
                  disabled={sendDisabledReason !== null || busy === "send"}
                  title={sendDisabledReason ?? undefined}
                  className="opt-btn-primary"
                >
                  {busy === "send" ? "Populating…" : "Populate Result Pages"}
                </button>
                {busy === "send" && (
                  <button
                    type="button"
                    onClick={cancelSendEvents}
                    className="opt-btn-danger"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {sendDisabledReason && (
                <p className="opt-text-warning">{sendDisabledReason}</p>
              )}

              {sendLog.length > 0 && (
                <pre className="opt-log-dark">
                  {sendLog.join("\n")}
                </pre>
              )}
            </div>
          )}

          {step7Tab === "demo" && (
            <div className="space-y-4 pt-4">
              <div>
                <p className="opt-label mb-2">Traffic allocation</p>
                <ul className="opt-body-text mb-3 list-inside list-disc">
                  {loaded.variations.map((v) => {
                    const role =
                      controlTreatment?.control.variation_id === v.variation_id
                        ? "control"
                        : controlTreatment?.treatment.variation_id === v.variation_id
                          ? "treatment"
                          : "not used in A/B sim";
                    return (
                      <li key={v.variation_id}>
                        {v.name}{" "}
                        <span className="opt-hint">
                          (<code className="text-xs">{v.variation_id}</code>) — {role}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="opt-hint">
                  <strong className="opt-label">All traffic to variation</strong>{" "}
                  updates Optimizely experiment weights (100% to the challenger, 0% to Original and others) and matches
                  fake logx sends. Click again to restore a 50/50 split.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <AllTrafficToVariationButton
                    applying={trafficApplying}
                    active={trafficMode === "all_treatment"}
                    treatmentName={controlTreatment?.treatment.name}
                    onClick={() => void toggleTrafficToVariation()}
                  />
                </div>
                {trafficStatus && (
                  <p className="mt-2 opt-alert-info">{trafficStatus}</p>
                )}
                {trafficMode === "all_treatment" && controlTreatment && !trafficStatus && (
                  <p className="mt-2 opt-alert-info">
                    Active: Optimizely + logx send 100% → {controlTreatment.treatment.name}.
                  </p>
                )}
              </div>

              <div className="opt-divider">
                <p className="opt-label mb-2">Experiment lifecycle</p>
                <p className="opt-hint mb-3">
                  Start or pause the experiment in Optimizely (
                  <code className="opt-code text-[11px]">PATCH ?action=start|pause</code>
                  ). Paused experiments stop counting new visitors in Results.
                </p>
                {experimentLiveStatus && (
                  <p className="opt-hint mb-3">
                    Current status:{" "}
                    <span className="opt-label">{experimentLiveStatus}</span>
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void runExperimentLifecycle("start")}
                    disabled={
                      lifecycleBusy ||
                      !experimentId.trim() ||
                      experimentLiveStatus?.toLowerCase() === "running"
                    }
                    className="opt-btn-success"
                  >
                    {lifecycleBusy ? "Updating…" : "Start experiment"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runExperimentLifecycle("pause")}
                    disabled={
                      lifecycleBusy ||
                      !experimentId.trim() ||
                      experimentLiveStatus?.toLowerCase() === "paused"
                    }
                    className="opt-btn-secondary"
                  >
                    {lifecycleBusy ? "Updating…" : "Pause experiment"}
                  </button>
                </div>
                {lifecycleMessage && (
                  <p className="mt-2 opt-alert-info">{lifecycleMessage}</p>
                )}
              </div>
            </div>
          )}

          {step7Tab === "validation" && (
            <div className="space-y-4 pt-4">
              <div className="flex flex-wrap gap-2">
                <CopyValidationDetailsButton onCopy={copyValidationDetails} />
              </div>

              <div className="opt-divider">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <p className="opt-label">Validate setup (Optimizely API)</p>
                  <button
                    type="button"
                    onClick={() => void runValidationSetup()}
                    disabled={validationLoading || !experimentId.trim() || !loaded}
                    className="opt-btn-secondary px-2.5 py-1 text-xs"
                  >
                    {validationLoading ? "Validating…" : "Validate setup"}
                  </button>
                </div>
                <p className="opt-hint mb-3">
                  Calls GET /v2/experiments/&#123;id&#125;/results plus experiment and event config checks. Confirms
                  metrics are counting — not just that logx returned 204.
                </p>
                {validationError && (
                  <p className="opt-text-warning">{validationError}</p>
                )}
                {validationReport && (
                  <div className="space-y-3">
                    <div className="opt-meta-panel">
                      <p>
                        {validationReport.projectName && <>{validationReport.projectName} · </>}
                        {validationReport.experimentName && <>{validationReport.experimentName} · </>}
                        Experiment {validationReport.experimentStatus ?? "—"} ·{" "}
                        {validationReport.meta.totalVisitors.toLocaleString()} visitors in Results
                        {validationReport.meta.lastCalculated &&
                          ` · calculated ${new Date(validationReport.meta.lastCalculated).toLocaleString()}`}
                        {validationReport.meta.isStale && " · stale (still processing)"}
                      </p>
                      {validationReport.meta.startTime && validationReport.meta.endTime && (
                        <p className="mt-1">
                          Date range: {new Date(validationReport.meta.startTime).toLocaleDateString()} –{" "}
                          {new Date(validationReport.meta.endTime).toLocaleDateString()}
                          {validationReport.meta.confidenceLevel != null &&
                            ` · ${Math.round(validationReport.meta.confidenceLevel * 100)}% confidence`}
                        </p>
                      )}
                    </div>
                    <ul className="space-y-2">
                      {validationReport.checks.map((check) => (
                        <li
                          key={`${check.status}-${check.title}`}
                          className={
                            "rounded-md border px-3 py-2 text-xs " + validationCheckClass(check.status)
                          }
                        >
                          <span className="font-medium uppercase tracking-wide">{check.status}</span>
                          {" — "}
                          <span className="font-medium">{check.title}</span>
                          {": "}
                          {check.detail}
                        </li>
                      ))}
                    </ul>
                    {validationReport.metrics.map((metric) => {
                      const isRevenue = metric.field === "revenue" && metric.aggregator === "sum";
                      return (
                        <div
                          key={metric.name}
                          className="opt-table-wrap"
                        >
                          <p className="opt-table-caption">
                            {metric.name}
                            {metric.aggregator && (
                              <span className="opt-hint ml-2 font-normal">({metric.aggregator})</span>
                            )}
                            {metric.winnerVariationId && (
                              <span className="opt-winner ml-2 text-xs font-normal">
                                winner declared
                              </span>
                            )}
                          </p>
                          <table className="opt-table text-xs">
                            <thead>
                              <tr>
                                <th>Variation</th>
                                <th>Visitors</th>
                                <th>{isRevenue ? "Total revenue (USD)" : "Unique conversions"}</th>
                                <th>{isRevenue ? "—" : "Conv. rate"}</th>
                                <th>Improvement</th>
                              </tr>
                            </thead>
                            <tbody>
                              {metric.variations.map((v) => (
                                <tr key={v.name}>
                                  <td>
                                    {v.name}
                                    {v.isWinner && (
                                      <span className="opt-winner ml-1">★</span>
                                    )}
                                  </td>
                                  <td>{v.visitors.toLocaleString()}</td>
                                  <td>
                                    {isRevenue
                                      ? `$${v.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                      : v.conversions.toLocaleString()}
                                  </td>
                                  <td>{isRevenue ? "—" : `${v.ratePercent.toFixed(1)}%`}</td>
                                  <td>
                                    {v.isBaseline
                                      ? "—"
                                      : v.liftPercent != null
                                        ? `${v.liftPercent >= 0 ? "+" : ""}${v.liftPercent.toFixed(0)}%${
                                            v.liftSignificant ? "" : " (n.s.)"
                                          }`
                                        : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <NewProjectModal
        open={newProjectModalOpen}
        name={newProjectName}
        product={newProjectProduct}
        createdProjectId={createdNewProjectId}
        busy={newProjectBusy}
        error={newProjectModalError}
        message={newProjectModalMessage}
        onNameChange={setNewProjectName}
        onProductChange={setNewProjectProduct}
        onClose={closeNewProjectModal}
        onCreateProject={() => void createNewProject()}
        onCreateMetrics={() => void createNewProjectMetrics()}
      />

      <CreateNewTestModal
        open={newTestModalOpen}
        name={newTestName}
        testKind={newTestKind}
        metrics={newTestMetrics}
        busy={newTestBusy}
        error={newTestModalError}
        message={newTestModalMessage}
        onNameChange={setNewTestName}
        onTestKindChange={setNewTestKind}
        onMetricsChange={setNewTestMetrics}
        onClose={closeNewTestModal}
        onCreate={() => void createNewTest()}
      />
    </div>
  );
}
