import { NextResponse } from "next/server";
import {
  getExperimentStatus,
  setExperimentLifecycle,
  type ExperimentLifecycleAction,
} from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

function parseAction(raw: unknown): ExperimentLifecycleAction | null {
  const a = String(raw ?? "").trim().toLowerCase();
  if (a === "start" || a === "pause") return a;
  return null;
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

  const experimentId = String(body.experimentId ?? "").trim();
  if (!experimentId) {
    return NextResponse.json({ error: "experimentId is required" }, { status: 400 });
  }

  const action = parseAction(body.action);
  if (body.action == null || body.action === "") {
    const status = await getExperimentStatus(token, experimentId);
    if ("error" in status) {
      return NextResponse.json({ error: status.error }, { status: status.status ?? 502 });
    }
    return NextResponse.json(status);
  }

  if (!action) {
    return NextResponse.json({ error: "action must be start or pause" }, { status: 400 });
  }

  const result = await setExperimentLifecycle(token, experimentId, action);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 502 });
  }

  const latest = await getExperimentStatus(token, experimentId);
  return NextResponse.json({
    action,
    status: "error" in latest ? result.status : latest.status,
  });
}
