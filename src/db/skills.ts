import {
  BehavioralSkill,
  SkillEvaluation,
  SkillPerformance,
  SkillTaskRun,
} from '../types.js';
import { getDb } from './instance.js';

// --- Behavioral skills accessors ---

export function getActiveSkills(
  groupFolder?: string | null,
): BehavioralSkill[] {
  return getDb()
    .prepare(
      `SELECT * FROM behavioral_skills
       WHERE status IN ('active', 'candidate')
         AND (group_folder IS NULL OR group_folder = ?)
       ORDER BY name`,
    )
    .all(groupFolder ?? null) as BehavioralSkill[];
}

export function getSkillByName(
  name: string,
  groupFolder?: string | null,
): BehavioralSkill | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM behavioral_skills
       WHERE name = ? AND status = 'active'
         AND (group_folder IS NULL OR group_folder = ?)
       ORDER BY version DESC LIMIT 1`,
    )
    .get(name, groupFolder ?? null) as BehavioralSkill | undefined;
}

export function getSkillById(id: string): BehavioralSkill | undefined {
  return getDb()
    .prepare('SELECT * FROM behavioral_skills WHERE id = ?')
    .get(id) as BehavioralSkill | undefined;
}

export function insertSkill(skill: BehavioralSkill): void {
  getDb()
    .prepare(
      `INSERT INTO behavioral_skills (id, name, version, content, description, parent_id, status, created_at, group_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      skill.id,
      skill.name,
      skill.version,
      skill.content,
      skill.description,
      skill.parent_id,
      skill.status,
      skill.created_at,
      skill.group_folder,
    );
}

export function updateSkillStatus(
  id: string,
  status: BehavioralSkill['status'],
): void {
  getDb()
    .prepare('UPDATE behavioral_skills SET status = ? WHERE id = ?')
    .run(status, id);
}

export function getSkillVersionCount(
  name: string,
  groupFolder: string | null,
): number {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) as cnt FROM behavioral_skills WHERE name = ? AND ((group_folder IS NULL AND ? IS NULL) OR (group_folder = ?))',
    )
    .get(name, groupFolder, groupFolder) as { cnt: number };
  return row.cnt;
}

export function recordSkillTaskRun(run: SkillTaskRun): void {
  getDb()
    .prepare(
      `INSERT INTO skill_task_runs (id, group_folder, chat_jid, rollout_id, prompt_summary, response_summary, tool_calls, duration_ms, status, created_at, evaluation_deadline, worker_task_id, root_outcome_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.group_folder,
      run.chat_jid,
      run.rollout_id,
      run.prompt_summary,
      run.response_summary,
      run.tool_calls,
      run.duration_ms,
      run.status,
      run.created_at,
      run.evaluation_deadline,
      run.worker_task_id ?? null,
      run.root_outcome_score ?? null,
    );
}

export function getTaskRun(id: string): SkillTaskRun | undefined {
  return getDb()
    .prepare('SELECT * FROM skill_task_runs WHERE id = ?')
    .get(id) as SkillTaskRun | undefined;
}

export function recordSkillSelections(runId: string, skillIds: string[]): void {
  const stmt = getDb().prepare(
    'INSERT OR IGNORE INTO skill_run_selections (run_id, skill_id) VALUES (?, ?)',
  );
  for (const skillId of skillIds) {
    stmt.run(runId, skillId);
  }
}

export function getSkillSelectionsForRun(runId: string): string[] {
  const rows = getDb()
    .prepare('SELECT skill_id FROM skill_run_selections WHERE run_id = ?')
    .all(runId) as Array<{ skill_id: string }>;
  return rows.map((r) => r.skill_id);
}

export function getRunsNeedingEvaluation(): SkillTaskRun[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT r.* FROM skill_task_runs r
       LEFT JOIN skill_evaluations e ON e.run_id = r.id
       WHERE r.evaluation_deadline IS NOT NULL
         AND r.evaluation_deadline <= ?
         AND e.id IS NULL
       ORDER BY r.created_at`,
    )
    .all(now) as SkillTaskRun[];
}

export function recordEvaluation(evaluation: SkillEvaluation): void {
  getDb()
    .prepare(
      `INSERT INTO skill_evaluations (id, run_id, score, dimensions, evaluation_source, evaluator_reasoning, raw_feedback, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evaluation.id,
      evaluation.run_id,
      evaluation.score,
      evaluation.dimensions,
      evaluation.evaluation_source,
      evaluation.evaluator_reasoning,
      evaluation.raw_feedback,
      evaluation.evaluated_at,
    );
}

export function getEvaluationForRun(
  runId: string,
): SkillEvaluation | undefined {
  return getDb()
    .prepare('SELECT * FROM skill_evaluations WHERE run_id = ?')
    .get(runId) as SkillEvaluation | undefined;
}

export function updateSkillPerformance(skillId: string): void {
  const now = new Date().toISOString();
  const db = getDb();

  // Calculate avg score from all evaluations where this skill was used
  const stats = db
    .prepare(
      `SELECT COUNT(*) as total, AVG(e.score) as avg_score
       FROM skill_evaluations e
       JOIN skill_run_selections s ON s.run_id = e.run_id
       WHERE s.skill_id = ?`,
    )
    .get(skillId) as { total: number; avg_score: number | null };

  // Recent average (last 10 evaluations)
  const recent = db
    .prepare(
      `SELECT AVG(e.score) as recent_avg
       FROM (
         SELECT e.score FROM skill_evaluations e
         JOIN skill_run_selections s ON s.run_id = e.run_id
         WHERE s.skill_id = ?
         ORDER BY e.evaluated_at DESC LIMIT 10
       ) e`,
    )
    .get(skillId) as { recent_avg: number | null };

  db.prepare(
    `INSERT INTO skill_performance (skill_id, total_runs, avg_score, recent_avg_score, last_updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       total_runs = excluded.total_runs,
       avg_score = excluded.avg_score,
       recent_avg_score = excluded.recent_avg_score,
       last_updated = excluded.last_updated`,
  ).run(
    skillId,
    stats.total,
    stats.avg_score ?? 0,
    recent.recent_avg ?? 0,
    now,
  );
}

export function getSkillPerformance(
  skillId: string,
): SkillPerformance | undefined {
  return getDb()
    .prepare('SELECT * FROM skill_performance WHERE skill_id = ?')
    .get(skillId) as SkillPerformance | undefined;
}

export function getAllSkillPerformance(): SkillPerformance[] {
  return getDb()
    .prepare('SELECT * FROM skill_performance')
    .all() as SkillPerformance[];
}

export function getRecentEvaluationCount(sinceTimestamp: string): number {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) as cnt FROM skill_evaluations WHERE evaluated_at > ?',
    )
    .get(sinceTimestamp) as { cnt: number };
  return row.cnt;
}

export function getTotalEvaluatedRuns(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM skill_evaluations')
    .get() as { cnt: number };
  return row.cnt;
}

export function getLowScoringRuns(
  minRuns: number,
  maxScore: number,
  limit: number = 20,
): Array<SkillTaskRun & { score: number; dimensions: string | null }> {
  return getDb()
    .prepare(
      `SELECT r.*, e.score, e.dimensions
       FROM skill_task_runs r
       JOIN skill_evaluations e ON e.run_id = r.id
       WHERE e.score < ?
       ORDER BY e.score ASC
       LIMIT ?`,
    )
    .all(maxScore, limit) as Array<
    SkillTaskRun & { score: number; dimensions: string | null }
  >;
}

export function getRecentUnevaluatedRun(
  chatJid: string,
): SkillTaskRun | undefined {
  return getDb()
    .prepare(
      `SELECT r.* FROM skill_task_runs r
       LEFT JOIN skill_evaluations e ON e.run_id = r.id
       WHERE r.chat_jid = ? AND r.status = 'success' AND e.id IS NULL
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(chatJid) as SkillTaskRun | undefined;
}

export function insertEvolutionLog(log: {
  id: string;
  group_folder: string | null;
  action: string;
  skill_id: string;
  changes_summary: string | null;
  trigger_reason: string;
  created_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO skill_evolution_log (id, group_folder, action, skill_id, changes_summary, trigger_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      log.id,
      log.group_folder,
      log.action,
      log.skill_id,
      log.changes_summary,
      log.trigger_reason,
      log.created_at,
    );
}

export function getLastEvolutionTimestamp(): string | null {
  const row = getDb()
    .prepare(
      'SELECT created_at FROM skill_evolution_log ORDER BY created_at DESC LIMIT 1',
    )
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}
