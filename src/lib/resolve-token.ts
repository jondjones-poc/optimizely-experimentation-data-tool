export function resolveOptimizelyToken(
  req: Request,
  body: Record<string, unknown>,
): string {
  const headerAuth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  const envToken = process.env.OPTIMIZELY_API_TOKEN?.trim();
  const bodyToken = typeof body.token === "string" ? body.token.trim() : "";
  return bodyToken || headerAuth || envToken || "";
}
