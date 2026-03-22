import { logger } from '../logger.js';
import { WallEntry, WorkerTask } from '../types.js';
import { getDb } from './instance.js';

export function insertWorkerTask(task: WorkerTask): void {
  getDb()
    .prepare(
      `INSERT INTO worker_tasks (id, group_folder, chat_jid, parent_task_id, depth, description, assigned_worker, status, result, error, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.group_folder,
      task.chat_jid,
      task.parent_task_id,
      task.depth,
      task.description,
      task.assigned_worker,
      task.status,
      task.result,
      task.error,
      task.created_at,
      task.started_at,
      task.completed_at,
    );
}

export function getWorkerTask(id: string): WorkerTask | undefined {
  return getDb()
    .prepare('SELECT * FROM worker_tasks WHERE id = ?')
    .get(id) as WorkerTask | undefined;
}

export function getPendingWorkerTasks(limit: number = 5): WorkerTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM worker_tasks WHERE status = 'pending' ORDER BY depth ASC, created_at ASC LIMIT ?`,
    )
    .all(limit) as WorkerTask[];
}

export function updateWorkerTask(
  id: string,
  updates: Partial<
    Pick<
      WorkerTask,
      | 'status'
      | 'assigned_worker'
      | 'result'
      | 'error'
      | 'started_at'
      | 'completed_at'
    >
  >,
): void {
  const ALLOWED_WORKER_TASK_FIELDS = new Set([
    'status',
    'assigned_worker',
    'result',
    'error',
    'started_at',
    'completed_at',
  ]);
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_WORKER_TASK_FIELDS.has(key)) {
      throw new Error(`updateWorkerTask: disallowed field "${key}"`);
    }
  }
  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values = [...Object.values(updates), id];
  const stmt = getDb().prepare(
    `UPDATE worker_tasks SET ${fields} WHERE id = ?`,
  );
  stmt.run(...values);
}

export function getChildTasks(parentId: string): WorkerTask[] {
  return getDb()
    .prepare('SELECT * FROM worker_tasks WHERE parent_task_id = ?')
    .all(parentId) as WorkerTask[];
}

export function getRootTaskId(taskId: string): string {
  const visited = new Set<string>();
  let current = getWorkerTask(taskId);
  let iterations = 0;
  const MAX_ITERATIONS = 100;
  while (current?.parent_task_id) {
    if (visited.has(current.id)) {
      logger.warn(
        { taskId, cycleAt: current.id },
        'Cycle detected in worker task parent chain',
      );
      return current.id;
    }
    visited.add(current.id);
    iterations++;
    if (iterations >= MAX_ITERATIONS) {
      logger.warn(
        { taskId, iterations },
        'Max iterations reached in getRootTaskId',
      );
      return current.id;
    }
    current = getWorkerTask(current.parent_task_id);
  }
  return current?.id ?? taskId;
}

// --- Wall ---

export function insertWallEntry(entry: WallEntry): void {
  getDb()
    .prepare(
      `INSERT INTO wall (id, root_task_id, group_folder, author, type, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.root_task_id,
      entry.group_folder,
      entry.author,
      entry.type,
      entry.content,
      entry.created_at,
    );
}

export function getWallEntries(rootTaskId: string): WallEntry[] {
  return getDb()
    .prepare(
      'SELECT * FROM wall WHERE root_task_id = ? ORDER BY created_at ASC',
    )
    .all(rootTaskId) as WallEntry[];
}
