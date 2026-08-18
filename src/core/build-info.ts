import fs from 'node:fs';
import path from 'node:path';
import { DB_DIR } from './db.js';

/**
 * A build fingerprint for the currently-running binary: the mtime of the file
 * the process started from. Captured while the process runs, it identifies the
 * code actually executing — even after the file on disk is overwritten by a
 * rebuild, because a long-lived process keeps serving the code it already
 * loaded. That is what makes a stale MCP server detectable against a freshly
 * rebuilt CLI: the server reports the mtime it saw, the CLI stamps the current
 * one into the graph marker, and a mismatch means "different binaries".
 */
export function currentBuildId(): string {
  try {
    const entry = process.argv[1];
    if (!entry) return 'unknown';
    return String(Math.floor(fs.statSync(entry).mtimeMs));
  } catch {
    return 'unknown';
  }
}

const BUILD_MARKER = 'analyzer-build.json';

/** Record which binary produced the current graph, for skew detection. */
export function writeAnalyzerBuild(projectDir: string, buildId: string): void {
  try {
    const dir = path.join(projectDir, DB_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BUILD_MARKER), JSON.stringify({ build: buildId }), 'utf-8');
  } catch {
    // best-effort — a missing marker just means "unknown", never a failure
  }
}

/** The build id that last analyzed this project, or null if never recorded. */
export function readAnalyzerBuild(projectDir: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, DB_DIR, BUILD_MARKER), 'utf-8')) as {
      build?: unknown;
    };
    return typeof data.build === 'string' ? data.build : null;
  } catch {
    return null;
  }
}

export interface BuildSkew {
  serverBuild: string;
  graphBuild: string | null;
  inSync: boolean | null;
  /** Actionable message when out of sync, else null. */
  advice: string | null;
}

/**
 * Compare the running server's build against the one that built the graph.
 * `inSync` is null when the graph has no marker (older graph or never analyzed).
 */
export function detectSkew(serverBuild: string, graphBuild: string | null): BuildSkew {
  if (graphBuild === null || serverBuild === 'unknown' || graphBuild === 'unknown') {
    return { serverBuild, graphBuild, inSync: null, advice: null };
  }
  if (serverBuild === graphBuild) {
    return { serverBuild, graphBuild, inSync: true, advice: null };
  }
  const s = Number(serverBuild);
  const g = Number(graphBuild);
  const advice =
    Number.isFinite(s) && Number.isFinite(g) && g > s
      ? 'The graph was built by a newer binary than this running MCP server. Restart the MCP server so it picks up the update.'
      : "This MCP server is newer than the graph it is serving. Run 'shanpan analyze --full' to rebuild against the current binary.";
  return { serverBuild, graphBuild, inSync: false, advice };
}
