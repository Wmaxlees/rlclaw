-- debug-skills.sql
-- Run with: sqlite3 store/messages.db < scripts/debug-skills.sql
-- Or interactively: sqlite3 store/messages.db

.mode column
.headers on
.separator ROW "\n"

-- ─── Skills overview ────────────────────────────────────────────────────────

SELECT '=== SKILLS ===' AS '';

SELECT
  bs.name,
  bs.version,
  bs.status,
  bs.group_folder,
  ROUND(sp.avg_score, 3)        AS avg_score,
  ROUND(sp.recent_avg_score, 3) AS recent_avg,
  sp.total_runs,
  bs.created_at
FROM behavioral_skills bs
LEFT JOIN skill_performance sp ON sp.skill_id = bs.id
ORDER BY bs.name, bs.version;

-- ─── Full skill content (with evolution notes) ───────────────────────────────

SELECT '=== SKILL CONTENT ===' AS '';

SELECT
  name || ' v' || version || ' [' || status || ']' AS skill,
  content
FROM behavioral_skills
ORDER BY name, version;

-- ─── Recent evaluations ──────────────────────────────────────────────────────

SELECT '=== RECENT EVALUATIONS (last 20) ===' AS '';

SELECT
  se.evaluated_at,
  se.evaluation_source,
  ROUND(se.score, 3)              AS score,
  json_extract(se.dimensions, '$.helpfulness')   AS help,
  json_extract(se.dimensions, '$.accuracy')      AS acc,
  json_extract(se.dimensions, '$.efficiency')    AS eff,
  json_extract(se.dimensions, '$.tone')          AS tone,
  json_extract(se.dimensions, '$.tool_selection') AS tool_sel,
  se.evaluator_reasoning,
  r.turn_count,
  r.chat_jid
FROM skill_evaluations se
JOIN skill_task_runs str ON str.id = se.run_id
LEFT JOIN rollouts r ON r.id = str.rollout_id
ORDER BY se.evaluated_at DESC
LIMIT 20;

-- ─── Open rollouts ────────────────────────────────────────────────────────────

SELECT '=== OPEN ROLLOUTS ===' AS '';

SELECT
  r.id,
  r.chat_jid,
  r.group_folder,
  r.turn_count,
  r.created_at,
  r.last_activity_at
FROM rollouts r
WHERE r.status = 'open'
ORDER BY r.last_activity_at DESC;

-- ─── Evolution log ────────────────────────────────────────────────────────────

SELECT '=== EVOLUTION LOG ===' AS '';

SELECT
  created_at,
  action,
  skill_id,
  changes_summary,
  trigger_reason
FROM skill_evolution_log
ORDER BY created_at DESC
LIMIT 20;
