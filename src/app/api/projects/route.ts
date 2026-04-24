import { NextResponse } from "next/server";
import { fetchProjectsForAccount } from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const token = resolveOptimizelyToken(req, body);
  if (!token) {
    return NextResponse.json(
      { error: "Missing Optimizely API token (form, Authorization header, or OPTIMIZELY_API_TOKEN)." },
      { status: 401 },
    );
  }

  const out = await fetchProjectsForAccount(token);
  if ("error" in out) {
    return NextResponse.json({ error: out.error }, { status: out.status ?? 502 });
  }

  return NextResponse.json({ projects: out.projects });
}
