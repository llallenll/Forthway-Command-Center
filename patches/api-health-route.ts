// Copy to: app/api/health/route.ts  (in each site you deploy)
//
// Deliberately cheap and dependency-free: the deploy agent polls this every
// couple of seconds while waiting for the app to come back, and a health check
// that touches the database would report "unhealthy" during a DB blip and
// trigger a pointless rollback.
//
// Add ?deep=1 for a version that also pings the database — useful to check by
// hand, not used by the automatic rollback.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";

  const body: Record<string, unknown> = {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
  };

  if (deep) {
    try {
      const { prisma } = await import("@/lib/prisma");
      await prisma.$queryRaw`SELECT 1`;
      body.database = "ok";
    } catch (err) {
      body.ok = false;
      body.database = err instanceof Error ? err.message : "unreachable";
      return NextResponse.json(body, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
