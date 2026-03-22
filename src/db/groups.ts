import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { getDb } from './instance.js';

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    )
    .run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
    )
    .run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = getDb()
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: (() => {
      if (!row.container_config) return undefined;
      try {
        return JSON.parse(row.container_config);
      } catch (err) {
        logger.error({ jid: row.jid, err }, 'Failed to parse container_config');
        return undefined;
      }
    })(),
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = getDb()
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: (() => {
        if (!row.container_config) return undefined;
        try {
          return JSON.parse(row.container_config);
        } catch (err) {
          logger.error(
            { jid: row.jid, err },
            'Failed to parse container_config',
          );
          return undefined;
        }
      })(),
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}
