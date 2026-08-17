import { NextResponse } from "next/server";
import {
  createDemoTest,
  type DemoTestKind,
  type DemoTestMetricOptions,
} from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

function parseTestKind(raw: unknown): DemoTestKind | null {
  const k = String(raw ?? "").trim().toLowerCase();
  if (k === "ab" || k === "a/b" || k === "a_b") return "ab";
  if (k === "multiarmed_bandit" || k === "mab" || k === "multi-arm bandit") return "multiarmed_bandit";
  if (k === "personalization" || k === "personalisation") return "personalization";
  return null;
}

function parseMetricOptions(raw: unknown): DemoTestMetricOptions {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    revenue: o.revenue !== false,
    visitedPage: o.visitedPage !== false,
    clickedCta: o.clickedCta !== false,
  };
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = resolveOptimizelyToken(req, body);
  if (!token) {
    return NextResponse.json({ error: "Missing Optimizely API token" }, { status: 401 });
  }

  const projectId = String(body.projectId ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const testKind = parseTestKind(body.testKind);
  if (!testKind) {
    return NextResponse.json(
      { error: "testKind must be ab, multiarmed_bandit, or personalization" },
      { status: 400 },
    );
  }

  const metricOptions = parseMetricOptions(body.metrics);

  const result = await createDemoTest(token, projectId, name, testKind, metricOptions);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 502 });
  }

  return NextResponse.json(result);
}
