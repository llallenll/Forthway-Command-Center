// Reports the version this *running process* started with. The values are read
// once, at module load — deliberately. If new files land on disk without a
// restart, this endpoint keeps reporting the old version, which is exactly how
// the Command Center knows a restart is still pending, and how it catches a
// stop command that silently did nothing.

import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const startedAt = new Date().toISOString();

function readBuildInfo() {
  const cwd = process.cwd();
  try {
    // Written into the app directory by every Command Center deploy.
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
    // No build-info.json — a local dev run, or a manual git pull.
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return {
      version: pkg.version ?? null,
      name: pkg.name ?? null,
      releaseId: null,
      deployedAt: null,
      source: "package.json" as const,
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
