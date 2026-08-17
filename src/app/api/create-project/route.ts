import { NextResponse } from "next/server";
import { createOptimizelyProject, type DemoProjectProduct } from "@/lib/optimizely";
import { resolveOptimizelyToken } from "@/lib/resolve-token";

function parseProduct(raw: unknown): DemoProjectProduct | null {
  const p = String(raw ?? "").trim().toLowerCase();
  if (p === "web" || p === "feature") return p;
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

  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const product = parseProduct(body.product);
  if (!product) {
    return NextResponse.json(
      { error: "product must be web or feature" },
      { status: 400 },
    );
  }

  const result = await createOptimizelyProject(token, name, product);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 502 });
  }

  return NextResponse.json(result);
}
