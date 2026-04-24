"use client";

import { useCallback, useEffect, useState } from "react";

type Variation = { variation_id: string; name: string };
type Metric = { event_id: number; key: string };
type NamedEntity = { id: string; name: string };

type LoadResult = {
  accountId: string;
  variations: Variation[];
  metrics: Metric[];
};

const BATCH_SIZE = 1000;
const BATCH_DELAY_MS = 2000;
const REFERENCE =
  "https://github.com/theodorecharles/opti-demo-claude-commands/blob/main/commands/fake-data.md";

export function FakeDataForm() {
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [experimentId, setExperimentId] = useState("");

  const [campaigns, setCampaigns] = useState<NamedEntity[]>([]);
  const [experiments, setExperiments] = useState<NamedEntity[]>([]);
  const [manualIds, setManualIds] = useState(false);

  const [visitorCount, setVisitorCount] = useState("500");
  const [conversionProbability, setConversionProbability] = useState("0.35");

  const [loaded, setLoaded] = useState<LoadResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendLog, setSendLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<"campaigns" | "experiments" | "load" | "send" | null>(null);

  const toggleMetric = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const loadCampaigns = useCallback(async () => {
    setLoadError(null);
    setCampaigns([]);
    setExperiments([]);
    setCampaignId("");
    setExperimentId("");
    setLoaded(null);
    setSendLog([]);
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
      const data = (await res.json()) as { campaigns?: NamedEntity[]; error?: string };
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCampaigns(data.campaigns ?? []);
      if (!(data.campaigns?.length)) {
        setLoadError(
          "No campaigns returned for this project. Check the project ID and token scope, or use “Enter IDs manually”.",
        );
      } else {
        setLoadError(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, [token, projectId]);

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
        setExperiments(data.experiments ?? []);
        setExperimentId("");
        if (!(data.experiments?.length)) {
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

  useEffect(() => {
    if (manualIds) return;
    if (!campaignId.trim()) {
      setExperiments([]);
      setExperimentId("");
      return;
    }
    void loadExperimentsForCampaign(campaignId);
  }, [campaignId, manualIds, loadExperimentsForCampaign]);

  const loadExperimentDetails = useCallback(async () => {
    setLoadError(null);
    setLoaded(null);
    setSendLog([]);
    setBusy("load");
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
        variations: data.variations,
        metrics: data.metrics,
      });
      setSelectedKeys(new Set(data.metrics.map((m) => m.key)));
      if (!data.metrics.length) {
        setLoadError(
          "No custom-event metrics found (event_id on experiment metrics). Overall revenue / page-based metrics are skipped, same as the CLI workflow.",
        );
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, [token, projectId, experimentId]);

  const sendEvents = useCallback(async () => {
    if (!loaded) return;
    const total = Math.max(1, Math.floor(Number(visitorCount) || 0));
    const p = Math.min(1, Math.max(0, Number(conversionProbability) || 0));
    const metricsToFire = loaded.metrics.filter((m) => selectedKeys.has(m.key));
    if (!metricsToFire.length) {
      setSendLog(["Select at least one metric event to send."]);
      return;
    }
    if (!campaignId.trim()) {
      setSendLog(["Campaign ID is required to build activation events."]);
      return;
    }

    setBusy("send");
    const lines: string[] = [];
    let sent = 0;
    const batches = Math.ceil(total / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      const count = Math.min(BATCH_SIZE, total - sent);
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: loaded.accountId,
            projectId: projectId.trim(),
            campaignId: campaignId.trim(),
            experimentId: experimentId.trim(),
            variations: loaded.variations,
            metricsToFire,
            count,
            conversionProbability: p,
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
          setBusy(null);
          return;
        }
        sent += data.sent ?? count;
        lines.push(
          `[${b + 1}/${batches}] Sent ${data.sent} visitors (${sent}/${total}) → logx HTTP ${data.logxStatus ?? "?"}`,
        );
        setSendLog([...lines]);
      } catch (e) {
        lines.push(`[${b + 1}/${batches}] ${e instanceof Error ? e.message : "Network error"}`);
        setSendLog(lines);
        setBusy(null);
        return;
      }
      if (b + 1 < batches) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    lines.push(
      `Done. Sent ${sent} visitors in ${batches} batch(es). Results typically appear within about 1–5 minutes; refresh your Optimizely Results page.`,
    );
    setSendLog(lines);
    setBusy(null);
  }, [
    loaded,
    visitorCount,
    conversionProbability,
    selectedKeys,
    campaignId,
    projectId,
    experimentId,
  ]);

  const canLoadCampaigns = projectId.trim().length > 0 && busy === null;
  const canLoadDetails =
    busy === null &&
    projectId.trim().length > 0 &&
    campaignId.trim().length > 0 &&
    experimentId.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">
          Optimizely fake results data
        </h1>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Order matches the Optimizely model:{" "}
          <strong className="font-medium text-zinc-800 dark:text-zinc-200">project → campaigns → experiments</strong>
          . The REST API lists{" "}
          <a
            className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400"
            href="https://docs.developers.optimizely.com/web-experimentation/reference/list_campaigns"
            target="_blank"
            rel="noreferrer"
          >
            campaigns
          </a>{" "}
          for a project, then{" "}
          <a
            className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400"
            href="https://docs.developers.optimizely.com/web-experimentation/reference/list_experiments"
            target="_blank"
            rel="noreferrer"
          >
            experiments
          </a>{" "}
          for a campaign. Then we load metric definitions and send to{" "}
          <code className="rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-800">logx.optimizely.com</code>{" "}
          (see{" "}
          <a
            href={REFERENCE}
            className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400"
            target="_blank"
            rel="noreferrer"
          >
            fake-data reference
          </a>
          ).
        </p>
      </header>

      <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Connection</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">1. Optimizely API token</span>
          <span className="text-xs text-zinc-500">
            Personal access token (Settings → API). Or set server env{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">OPTIMIZELY_API_TOKEN</code> and leave this
            blank.
          </span>
          <input
            type="password"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Optional if env token is configured"
            autoComplete="off"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">2. Project ID</span>
          <span className="text-xs text-zinc-500">Number after /projects/ in the app URL</span>
          <input
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setCampaigns([]);
              setExperiments([]);
              setCampaignId("");
              setExperimentId("");
              setLoaded(null);
            }}
            placeholder="5562178971893760"
            autoComplete="off"
          />
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={manualIds}
            onChange={(e) => {
              const on = e.target.checked;
              setManualIds(on);
              setCampaigns([]);
              setExperiments([]);
              setCampaignId("");
              setExperimentId("");
              setLoaded(null);
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
              className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:enabled:hover:bg-white"
            >
              {busy === "campaigns" ? "Loading campaigns…" : "3. Load campaigns"}
            </button>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">4. Campaign</span>
              <span className="text-xs text-zinc-500">Choose after campaigns load (same ID as in /results/…)</span>
              <select
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                disabled={campaigns.length === 0 || busy === "campaigns" || busy === "experiments"}
              >
                <option value="">Select a campaign…</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name.length > 70 ? `${c.name.slice(0, 67)}…` : c.name} ({c.id})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">5. Experiment</span>
              <span className="text-xs text-zinc-500">
                Populated when a campaign is selected (same ID as in /experiments/…)
              </span>
              <select
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
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

        {manualIds && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="font-medium">Campaign ID</span>
              <span className="text-xs text-zinc-500">Number after /results/</span>
              <input
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                placeholder="9300002367830"
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="font-medium">Experiment ID</span>
              <span className="text-xs text-zinc-500">Number after /experiments/</span>
              <input
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
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
          className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:enabled:hover:bg-white"
        >
          {busy === "load" ? "Loading…" : "6. Load experiment details (metrics)"}
        </button>
        {loadError && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
            {loadError}
          </p>
        )}
      </section>

      {loaded && (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Experiment</h2>
          <p className="text-xs text-zinc-500">
            Account ID: <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{loaded.accountId}</code>
            {" · "}
            Campaign: <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{campaignId || "—"}</code>
            {" · "}
            Experiment:{" "}
            <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{experimentId || "—"}</code>
          </p>
          <div>
            <p className="mb-2 text-sm font-medium">Variations</p>
            <ul className="list-inside list-disc text-sm text-zinc-700 dark:text-zinc-300">
              {loaded.variations.map((v) => (
                <li key={v.variation_id}>
                  {v.name}{" "}
                  <span className="text-zinc-500">
                    (<code className="text-xs">{v.variation_id}</code>)
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Metric events (custom event backers)</p>
            {loaded.metrics.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">None resolved.</p>
            ) : (
              <ul className="space-y-2">
                {loaded.metrics.map((m) => (
                  <li key={m.key}>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedKeys.has(m.key)}
                        onChange={() => toggleMetric(m.key)}
                      />
                      <span>
                        <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{m.key}</code>
                        <span className="text-zinc-500"> — event_id {m.event_id}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Visitors to simulate</span>
              <span className="text-xs text-zinc-500">
                Each visitor gets random IDs, a random variation,{" "}
                <code className="rounded bg-zinc-100 px-0.5 text-[11px] dark:bg-zinc-800">campaign_activated</code>
                , and sampled conversions for the metrics you checked.
              </span>
              <input
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
                value={visitorCount}
                onChange={(e) => setVisitorCount(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Conversion probability</span>
              <span className="text-xs text-zinc-500">
                Per selected metric, per visitor (0–1). Example: 0.35 ≈ 35% chance each metric fires.
              </span>
              <input
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[var(--foreground)] dark:border-zinc-700 dark:bg-zinc-900"
                value={conversionProbability}
                onChange={(e) => setConversionProbability(e.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => void sendEvents()}
            disabled={
              busy !== null ||
              !loaded.metrics.length ||
              !campaignId.trim() ||
              selectedKeys.size === 0
            }
            title={
              !campaignId.trim()
                ? "Select a campaign (or enter IDs manually)"
                : selectedKeys.size === 0
                  ? "Select at least one metric"
                  : !loaded.metrics.length
                    ? "No metric events from API"
                    : undefined
            }
            className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "send" ? "Sending…" : "Send to Optimizely logx"}
          </button>

          {sendLog.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-100">
              {sendLog.join("\n")}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
