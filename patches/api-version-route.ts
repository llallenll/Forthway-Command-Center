// Copy to: app/api/version/route.ts  (in each site you deploy)
//
// Reports the version this *running process* started with. The values are read
// once, at module load — deliberately. If new files land on disk without a
// restart, this endpoint keeps reporting the old version, which is exactly how
// the Command Center knows a restart is still pending.

import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const startedAt = new Date().toISOString();

function readBuildInfo() {
  const cwd = process.cwd();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(cwd, "build-info.json"), "utf8"));
    return {
      version: info.version ?? null,
      releaseId: info.releaseId ?? null,
      zipName: info.zipName ?? null,
      buildMode: info.buildMode ?? null,
      deployedAt: info.deployedAt ?? null,
      source: "build-info.json" as const,
    };
  } catch {
    // No build-info.json yet (first deploy, or a manual `git pull`) — fall back
    // to whatever package.json says.
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return {
      version: pkg.version ?? null,
      releaseId: null,
      zipName: null,
      buildMode: null,
      deployedAt: null,
      source: "package.json" as const,
      name: pkg.name ?? null,
    };
  } catch {
    return { version: null, releaseId: null, source: "unknown" as const };
  }
}

const BUILD = readBuildInfo();

export async function GET() {
  return NextResponse.json(
    {
      ...BUILD,
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      env: process.env.NODE_ENV ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
