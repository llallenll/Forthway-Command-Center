// The Command Center polls this every couple of seconds while it waits for the
// app to come back after a deploy, so it is deliberately cheap: no database, no
// external calls. A health check that touched the database would report
// "unhealthy" during a blip and trigger a pointless rollback.
//
// If this site grows a database, put the deep check behind ?deep=1 rather than
// in the default path.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(
    { ok: true, uptimeSeconds: Math.round(process.uptime()), checkedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
