/**
 * Template copied to .opencode/plugin/specgraph-drift.ts by specgraph init/upgrade.
 */

export const PLUGIN_MARKER = '<!-- specgraph-managed-plugin -->';

export const specgraphDriftPluginSource = `import type { Plugin } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SpecgraphDriftPlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
      if (!sessionID) return;

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          "specgraph",
          ["check", "--hook-output", "--format", "opencode"],
          { cwd: process.cwd() },
        ));
      } catch {
        return;
      }

      let payload: { prompt?: string };
      try {
        payload = JSON.parse(stdout.trim() || "{}") as { prompt?: string };
      } catch {
        return;
      }
      if (!payload.prompt) return;

      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: payload.prompt }] },
      });
    },
  };
};

export default SpecgraphDriftPlugin;

${PLUGIN_MARKER}
`;
