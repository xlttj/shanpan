import fs from 'node:fs';
import path from 'node:path';
import { shanpanDriftPluginSource } from '../opencode/shanpan-drift.plugin.js';

export interface IdeIntegration {
  id: string;
  label: string;
  settingsPath: string; // relative to project root
  detectionPath?: string; // directory to probe for auto-detection; defaults to dirname(settingsPath)
  buildHooksConfig(): object;
}

const CLAUDE_HOOKS_CONFIG = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            // Reads hook JSON from stdin, outputs spec context for the file being edited.
            // Outputs nothing (allow passthrough) when the file has no linked specs.
            command: 'shanpan context',
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'shanpan analyze > /dev/null 2>&1',
            async: true,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'shanpan check --hook-output',
          },
        ],
      },
    ],
  },
};

export const claudeCodeIntegration: IdeIntegration = {
  id: 'claude',
  label: 'Claude Code',
  settingsPath: '.claude/settings.json',
  buildHooksConfig: () => CLAUDE_HOOKS_CONFIG,
};

/**
 * Cursor's own hook schema: version 1, camelCase events, a flat array per event.
 * It shares no field names with Claude Code's, so reusing that config here left
 * Cursor with a file it never reads. Cursor also reads `.cursor/hooks.json`
 * only — never `.cursor/settings.json`.
 *
 * The notable absence is a pre-edit context hook. Cursor's `preToolUse` accepts
 * only permission/messages/updated_input, so knowledge reaches the agent through
 * auto-attached rules (`shanpan rules`) instead, regenerated whenever the
 * graph changes.
 */
const CURSOR_HOOKS_CONFIG = {
  version: 1,
  hooks: {
    sessionStart: [{ command: 'shanpan rules > /dev/null 2>&1' }],
    postToolUse: [
      {
        matcher: 'Write',
        command: 'shanpan analyze > /dev/null 2>&1 && shanpan rules > /dev/null 2>&1',
      },
    ],
    stop: [{ command: 'shanpan check --hook-output --format cursor' }],
  },
};

export const cursorIntegration: IdeIntegration = {
  id: 'cursor',
  label: 'Cursor',
  settingsPath: '.cursor/hooks.json',
  buildHooksConfig: () => CURSOR_HOOKS_CONFIG,
};

/**
 * OpenCode experimental shell hooks sync the graph but cannot read hook JSON.
 * Drift feedback to the agent goes through the shanpan-drift plugin on
 * session.idle, which calls check --hook-output --format opencode.
 */
const OPENCODE_HOOKS_CONFIG = {
  experimental: {
    hook: {
      file_edited: [{ command: ['shanpan', 'analyze'] }],
      session_completed: [{ command: ['shanpan', 'check'] }],
    },
  },
};

export const openCodeIntegration: IdeIntegration = {
  id: 'opencode',
  label: 'OpenCode',
  settingsPath: 'opencode.json',
  detectionPath: '.opencode',
  buildHooksConfig: () => OPENCODE_HOOKS_CONFIG,
};

export const IDE_INTEGRATIONS: IdeIntegration[] = [claudeCodeIntegration, cursorIntegration, openCodeIntegration];

/**
 * Concatenate two arrays but drop structurally-identical entries. This keeps
 * the merge idempotent: re-running init/upgrade must not stack another copy of
 * the shanpan hooks, and a settings file that already accumulated duplicates
 * from an earlier (appending) version self-heals on the next run. User-added
 * entries differ structurally from ours and are always preserved.
 */
function mergeArrays(existing: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of [...existing, ...incoming]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (Array.isArray(value) && Array.isArray(result[key])) {
      result[key] = mergeArrays(result[key] as unknown[], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function mergeSettings(filePath: string, newConfig: object): void {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // malformed — start fresh
    }
  }
  const merged = deepMerge(existing, newConfig as Record<string, unknown>);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
}

export function installIdeHooks(projectDir: string, ide: IdeIntegration): void {
  const filePath = path.resolve(projectDir, ide.settingsPath);
  mergeSettings(filePath, ide.buildHooksConfig());
}

export function installOpenCodePlugin(projectDir: string): void {
  const pluginDir = path.join(projectDir, '.opencode', 'plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'shanpan-drift.ts'), shanpanDriftPluginSource, 'utf-8');
}
