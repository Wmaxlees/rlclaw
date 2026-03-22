import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

let db: Database.Database;

export interface Reaction {
  message_id: string;
  message_chat_jid: string;
  reactor_jid: string;
  reactor_name?: string;
  emoji: string;
  timestamp: string;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    -- Behavioral skills
    CREATE TABLE IF NOT EXISTS behavioral_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      description TEXT NOT NULL,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      group_folder TEXT,
      FOREIGN KEY (parent_id) REFERENCES behavioral_skills(id)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_status ON behavioral_skills(status);
    CREATE INDEX IF NOT EXISTS idx_skills_name ON behavioral_skills(name, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_version ON behavioral_skills(name, group_folder, version);

    CREATE TABLE IF NOT EXISTS rollouts (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      rollout_type TEXT NOT NULL DEFAULT 'conversation' CHECK (rollout_type IN ('conversation','worker')),
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      last_activity_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rollouts_status ON rollouts(status);
    CREATE INDEX IF NOT EXISTS idx_rollouts_chat ON rollouts(chat_jid, status);

    CREATE TABLE IF NOT EXISTS skill_task_runs (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      rollout_id TEXT REFERENCES rollouts(id),
      prompt_summary TEXT,
      response_summary TEXT,
      tool_calls TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      evaluation_deadline TEXT,
      worker_task_id TEXT REFERENCES worker_tasks(id),
      root_outcome_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_runs_deadline ON skill_task_runs(evaluation_deadline);
    -- rollout_id index is created in the migration section after the column is ensured
    CREATE INDEX IF NOT EXISTS idx_skill_runs_created ON skill_task_runs(created_at);

    CREATE TABLE IF NOT EXISTS skill_run_selections (
      run_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      PRIMARY KEY (run_id, skill_id),
      FOREIGN KEY (run_id) REFERENCES skill_task_runs(id),
      FOREIGN KEY (skill_id) REFERENCES behavioral_skills(id)
    );

    CREATE TABLE IF NOT EXISTS skill_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      score REAL NOT NULL,
      dimensions TEXT,
      evaluation_source TEXT NOT NULL,
      evaluator_reasoning TEXT,
      raw_feedback TEXT,
      evaluated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES skill_task_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_eval_run ON skill_evaluations(run_id);

    CREATE TABLE IF NOT EXISTS skill_performance (
      skill_id TEXT PRIMARY KEY,
      total_runs INTEGER NOT NULL DEFAULT 0,
      avg_score REAL NOT NULL DEFAULT 0.0,
      recent_avg_score REAL NOT NULL DEFAULT 0.0,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES behavioral_skills(id)
    );

    CREATE TABLE IF NOT EXISTS skill_evolution_log (
      id TEXT PRIMARY KEY,
      group_folder TEXT,
      action TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      changes_summary TEXT,
      trigger_reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      message_chat_jid TEXT NOT NULL,
      reactor_jid TEXT NOT NULL,
      reactor_name TEXT,
      emoji TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, message_chat_jid, reactor_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
    CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);

    CREATE TABLE IF NOT EXISTS worker_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      parent_task_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      assigned_worker TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (parent_task_id) REFERENCES worker_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_status ON worker_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_parent ON worker_tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_group ON worker_tasks(group_folder, chat_jid);

    CREATE TABLE IF NOT EXISTS wall (
      id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      author TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wall_root ON wall(root_task_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: context_mode column');
    }
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: is_bot_message column');
    }
  }

  // Add requires_trigger column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN requires_trigger INTEGER DEFAULT 1`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: requires_trigger column');
    }
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: channel/is_group columns');
    }
  }

  // Rollout columns migration
  try {
    database.exec(
      `ALTER TABLE skill_task_runs ADD COLUMN rollout_id TEXT REFERENCES rollouts(id)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: rollout_id column');
    }
  }
  try {
    database.exec(`ALTER TABLE skill_task_runs ADD COLUMN tool_calls TEXT`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: tool_calls column');
    }
  }
  try {
    database.exec(
      `ALTER TABLE skill_evaluations ADD COLUMN evaluator_reasoning TEXT`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: evaluator_reasoning column');
    }
  }

  // Worker rollout migrations
  try {
    database.exec(
      `ALTER TABLE rollouts ADD COLUMN rollout_type TEXT NOT NULL DEFAULT 'conversation' CHECK (rollout_type IN ('conversation','worker'))`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: rollout_type column');
    }
  }
  try {
    database.exec(
      `ALTER TABLE skill_task_runs ADD COLUMN worker_task_id TEXT REFERENCES worker_tasks(id)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: worker_task_id column');
    }
  }
  try {
    database.exec(
      `ALTER TABLE skill_task_runs ADD COLUMN root_outcome_score REAL`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
      logger.warn({ err }, 'Migration warning: root_outcome_score column');
    }
  }
  // Create rollout_id index after migration ensures the column exists
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_skill_runs_rollout ON skill_task_runs(rollout_id)`,
    );
  } catch {
    /* index already exists or column not yet available */
  }
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);
  db.pragma('foreign_keys = ON');

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Run a set of DB operations in a single better-sqlite3 transaction.
 * Usage: runDbTransaction(() => { insertSkill(…); updateSkillStatus(…); … });
 */
export function runDbTransaction(fn: () => void): void {
  getDb().transaction(fn)();
}

// --- JSON migration (private, called by initDatabase) ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    const database = getDb();
    if (routerState.last_timestamp) {
      database
        .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
        .run('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      database
        .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
        .run(
          'last_agent_timestamp',
          JSON.stringify(routerState.last_agent_timestamp),
        );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    const database = getDb();
    for (const [folder, sessionId] of Object.entries(sessions)) {
      database
        .prepare(
          'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
        )
        .run(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    const database = getDb();
    for (const [jid, group] of Object.entries(groups)) {
      if (!isValidGroupFolder(group.folder)) {
        logger.warn(
          { jid, folder: group.folder },
          'Skipping migrated registered group with invalid folder',
        );
        continue;
      }
      database
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
          group.requiresTrigger === undefined
            ? 1
            : group.requiresTrigger
              ? 1
              : 0,
        );
    }
  }
}
