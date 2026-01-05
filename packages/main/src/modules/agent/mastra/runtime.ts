import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal Mastra runtime inside Electron main process, with local LibSQL storage
// so we can leverage official AI Tracing / observability.
//
// We want ONE shared DB file for BOTH Electron runtime and Mastra Studio.
// Target absolute path: <repoRoot>/incarnation-electron/packages/main/.mastra/output/mastra.db
// This function computes that path robustly from the compiled file location,
// regardless of whether we're running from Electron's dist/ or Mastra's .mastra/output/.
function resolveSharedDbPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const dir = path.dirname(thisFile);

  // Normalise to POSIX-style for substring search
  const normalized = dir.replace(/\\/g, '/');
  const marker = '/packages/main';
  const idx = normalized.lastIndexOf(marker);

  // If we can find ".../packages/main", anchor there; otherwise, fall back to current dir.
  const base =
    idx >= 0 ? normalized.slice(0, idx + marker.length) : normalized;

  const dbDir = path.join(base, '.mastra', 'output');
  const dbPath = path.join(dbDir, 'mastra.db');

  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    // Best-effort; LibSQL will error clearly if directory truly can't be created.
  }

  return dbPath;
}

const sharedDbPath = resolveSharedDbPath();

export const mastraStorage = new LibSQLStore({
  // LibSQL accepts a "file:" URL for local SQLite; it will strip the scheme internally.
  url: `file:${sharedDbPath}`,
});

export const mastraMemory = new Memory({
  options: {
    lastMessages: 20,
    workingMemory: { enabled: true },
  },
});
// Wire memory to shared storage so MastraMemory can persist threads/messages
mastraMemory.setStorage(mastraStorage);

export const mastra = new Mastra({
  // Agents are still created ad-hoc in intent-agent.ts; we mainly want observability/tracing here.
  agents: {},
  storage: mastraStorage,
  observability: {
    default: { enabled: true },
  },
  telemetry: {
    enabled: false,
  },
});


