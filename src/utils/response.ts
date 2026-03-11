import { env } from "../config";

export function corsHeaders(requestOrigin?: string | null): Record<string, string> {
  const origin =
    requestOrigin && env.CORS_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : env.CORS_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...(env.CORS_ORIGINS.length > 1 ? { Vary: "Origin" } : {}),
  };
}

export function json(data: unknown, status = 200, requestOrigin?: string | null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(requestOrigin) },
  });
}
