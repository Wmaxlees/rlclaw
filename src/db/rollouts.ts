import { Rollout, SkillTaskRun, WorkerTask } from '../types.js';
import { getDb } from './instance.js';
import { getRootTaskId } from './workers.js';

export interface LowScoringRollout {
  rollout_id: string;
  avg_score: number;
  runs: Array<
    SkillTaskRun & {
      score: number;
      dimensions: string | null;
      evaluator_reasoning: string | null;
    }
  >;
}

export interface LowScoringWorkerRollout {
  rollout_id: string;
  avg_score: number;
  runs: Array<
    SkillTaskRun & {
      score: number;
      dimensions: string | null;
      evaluator_reasoning: string | null;
    }
  >;
}

export function insertRollout(rollout: Rollout): void {
  getDb()
    .prepare(
      `INSERT INTO rollouts (id, group_folder, chat_jid, status, rollout_type, turn_count, created_at, closed_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rollout.id,
      rollout.group_folder,
      rollout.chat_jid,
      rollout.status,
      rollout.rollout_type,
      rollout.turn_count,
      rollout.created_at,
      rollout.closed_at,
      rollout.last_activity_at,
    );
}

export function getOpenRollout(chatJid: string): Rollout | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM rollouts WHERE chat_jid = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatJid) as Rollout | undefined;
}

export function updateRollout(
  id: string,
  updates: Partial<
    Pick<Rollout, 'status' | 'turn_count' | 'closed_at' | 'last_activity_at'>
  >,
): void {
  const ALLOWED_ROLLOUT_FIELDS = new Set([
    'status',
    'turn_count',
    'closed_at',
    'last_activity_at',
  ]);
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_ROLLOUT_FIELDS.has(key)) {
      throw new Error(`updateRollout: disallowed field "${key}"`);
    }
  }
  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values = [...Object.values(updates), id];
  const stmt = getDb().prepare(`UPDATE rollouts SET ${fields} WHERE id = ?`);
  stmt.run(...values);
}

export function getClosedRolloutsNeedingEvaluation(): Rollout[] {
  return getDb()
    .prepare(
      `SELECT r.* FROM rollouts r
       WHERE r.status = 'closed'
         AND r.rollout_type = 'conversation'
         AND NOT EXISTS (
           SELECT 1 FROM skill_task_runs t
           JOIN skill_evaluations e ON e.run_id = t.id
           WHERE t.rollout_id = r.id
         )
         AND EXISTS (
           SELECT 1 FROM skill_task_runs t
           WHERE t.rollout_id = r.id AND t.status = 'success'
         )
       ORDER BY r.closed_at`,
    )
    .all() as Rollout[];
}

export function getRunsForRollout(rolloutId: string): SkillTaskRun[] {
  return getDb()
    .prepare(
      `SELECT * FROM skill_task_runs WHERE rollout_id = ? ORDER BY created_at`,
    )
    .all(rolloutId) as SkillTaskRun[];
}

export function getStaleOpenRollouts(inactivityCutoff: string): Rollout[] {
  return getDb()
    .prepare(
      `SELECT * FROM rollouts WHERE status = 'open' AND last_activity_at < ?`,
    )
    .all(inactivityCutoff) as Rollout[];
}

/**
 * Create a worker rollout for a root task tree. Idempotent — returns existing if present.
 * Worker rollout ID is deterministic: `worker-{rootTaskId}`
 */
export function createWorkerRollout(
  rootTaskId: string,
  chatJid: string,
  groupFolder: string,
): Rollout {
  const id = `worker-${rootTaskId}`;
  const existing = getDb()
    .prepare(`SELECT * FROM rollouts WHERE id = ?`)
    .get(id) as Rollout | undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  const rollout: Rollout = {
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    status: 'open',
    rollout_type: 'worker',
    turn_count: 0,
    created_at: now,
    closed_at: null,
    last_activity_at: now,
  };
  insertRollout(rollout);
  return rollout;
}

/**
 * Record a completed worker task as a run in its rollout.
 */
export function recordWorkerTaskRun(task: WorkerTask): void {
  const rolloutId = `worker-${getRootTaskId(task.id)}`;
  const durationMs =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() -
        new Date(task.started_at).getTime()
      : null;

  const runId = `wrun-${task.id}`;
  // Idempotent: skip if already recorded
  const existing = getDb()
    .prepare(`SELECT id FROM skill_task_runs WHERE id = ?`)
    .get(runId);
  if (existing) return;

  getDb()
    .prepare(
      `INSERT INTO skill_task_runs (id, group_folder, chat_jid, rollout_id, prompt_summary, response_summary, tool_calls, duration_ms, status, created_at, evaluation_deadline, worker_task_id, root_outcome_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      task.group_folder,
      task.chat_jid,
      rolloutId,
      task.description.slice(0, 500),
      task.result ? task.result.slice(0, 500) : (task.error?.slice(0, 200) ?? null),
      null,
      durationMs,
      task.status === 'done' ? 'success' : 'failed',
      new Date().toISOString(),
      null,
      task.id,
      null,
    );
}

/**
 * Close a worker rollout and mark it ready for evaluation.
 */
export function closeWorkerRollout(rootTaskId: string): void {
  const id = `worker-${rootTaskId}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE rollouts SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`,
    )
    .run(now, id);
}

/**
 * Set root_outcome_score on all runs in a worker rollout.
 * Called after synthesis is scored so the score propagates to all contributing tasks.
 */
export function updateRootOutcomeScore(
  rootTaskId: string,
  score: number,
): void {
  const rolloutId = `worker-${rootTaskId}`;
  getDb()
    .prepare(
      `UPDATE skill_task_runs SET root_outcome_score = ? WHERE rollout_id = ?`,
    )
    .run(score, rolloutId);
}

/**
 * Get closed worker rollouts that haven't been evaluated yet.
 */
export function getClosedWorkerRolloutsNeedingEvaluation(): Rollout[] {
  return getDb()
    .prepare(
      `SELECT r.* FROM rollouts r
       WHERE r.status = 'closed'
         AND r.rollout_type = 'worker'
         AND NOT EXISTS (
           SELECT 1 FROM skill_task_runs t
           JOIN skill_evaluations e ON e.run_id = t.id
           WHERE t.rollout_id = r.id
         )
         AND EXISTS (
           SELECT 1 FROM skill_task_runs t
           WHERE t.rollout_id = r.id
         )
       ORDER BY r.closed_at`,
    )
    .all() as Rollout[];
}

export function getLowScoringRollouts(
  maxScore: number,
  limit: number = 10,
): LowScoringRollout[] {
  const db = getDb();
  // Get rollouts whose average evaluation score is below the threshold
  const rolloutRows = db
    .prepare(
      `SELECT r.id as rollout_id, AVG(e.score) as avg_score
       FROM rollouts r
       JOIN skill_task_runs t ON t.rollout_id = r.id
       JOIN skill_evaluations e ON e.run_id = t.id
       WHERE r.status = 'closed' AND r.rollout_type = 'conversation'
       GROUP BY r.id
       HAVING avg_score < ?
       ORDER BY avg_score ASC
       LIMIT ?`,
    )
    .all(maxScore, limit) as Array<{ rollout_id: string; avg_score: number }>;

  return rolloutRows.map((row) => {
    const runs = db
      .prepare(
        `SELECT t.*, e.score, e.dimensions, e.evaluator_reasoning
         FROM skill_task_runs t
         LEFT JOIN skill_evaluations e ON e.run_id = t.id
         WHERE t.rollout_id = ?
         ORDER BY t.created_at`,
      )
      .all(row.rollout_id) as Array<
      SkillTaskRun & {
        score: number;
        dimensions: string | null;
        evaluator_reasoning: string | null;
      }
    >;
    return { rollout_id: row.rollout_id, avg_score: row.avg_score, runs };
  });
}

export function getLowScoringWorkerRollouts(
  maxScore: number,
  limit: number = 10,
): LowScoringWorkerRollout[] {
  const db = getDb();
  const rolloutRows = db
    .prepare(
      `SELECT r.id as rollout_id, AVG(e.score) as avg_score
       FROM rollouts r
       JOIN skill_task_runs t ON t.rollout_id = r.id
       JOIN skill_evaluations e ON e.run_id = t.id
       WHERE r.status = 'closed' AND r.rollout_type = 'worker'
       GROUP BY r.id
       HAVING avg_score < ?
       ORDER BY avg_score ASC
       LIMIT ?`,
    )
    .all(maxScore, limit) as Array<{ rollout_id: string; avg_score: number }>;

  return rolloutRows.map((row) => {
    const runs = db
      .prepare(
        `SELECT t.*, e.score, e.dimensions, e.evaluator_reasoning
         FROM skill_task_runs t
         JOIN skill_evaluations e ON e.run_id = t.id
         WHERE t.rollout_id = ?
         ORDER BY t.created_at`,
      )
      .all(row.rollout_id) as Array<
      SkillTaskRun & {
        score: number;
        dimensions: string | null;
        evaluator_reasoning: string | null;
      }
    >;
    return { rollout_id: row.rollout_id, avg_score: row.avg_score, runs };
  });
}
