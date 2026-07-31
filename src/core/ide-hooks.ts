import fs from 'node:fs';
import path from 'node:path';

export interface IdeIntegration {
  id: string;
  label: string;
  settingsPath: string; // relative to project root
  detectionPath?: string; // directory to probe for auto-detection; defaults to dirname(settingsPath)
  buildHooksConfig(): object;
}

const HOOKS_CONFIG = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            // Reads hook JSON from stdin, outputs spec context for the file being edited.
            // Outputs nothing (allow passthrough) when the file has no linked specs.
            command: 'specgraph context',
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
            command: 'specgraph analyze > /dev/null 2>&1',
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
            command: 'specgraph check --hook-output',
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
  buildHooksConfig: () => HOOKS_CONFIG,
};

export const cursorIntegration: IdeIntegration = {
  id: 'cursor',
  label: 'Cursor',
  settingsPath: '.cursor/settings.json',
  buildHooksConfig: () => HOOKS_CONFIG,
};

const OPENCODE_HOOKS_CONFIG = {
  experimental: {
    hook: {
      file_edited: [
        { command: ['specgraph', 'analyze'] },
      ],
      session_completed: [
        { command: ['specgraph', 'check', '--hook-output'] },
      ],
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
 * the specgraph hooks, and a settings file that already accumulated duplicates
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
