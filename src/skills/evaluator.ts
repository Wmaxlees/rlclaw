/**
 * Skill Evaluator
 * Runs a background loop that evaluates closed rollouts (multi-turn windows).
 * Each rollout contains up to ROLLOUT_SIZE consecutive turns, with tool calls
 * extracted from session transcripts. Uses a direct Anthropic API call.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { EVALUATION_POLL_INTERVAL } from '../config.js';
import {
  getActiveSkills,
  getClosedRolloutsNeedingEvaluation,
  getClosedWorkerRolloutsNeedingEvaluation,
  getRunsForRollout,
  getSkillSelectionsForRun,
  recordEvaluation,
  updateRootOutcomeScore,
  updateSkillPerformance,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { closeStaleRollouts, closeWorkerRollout } from './rollout-manager.js';

let evaluatorRunning = false;

const evaluatorPrompt = fs.readFileSync(
  path.join(process.cwd(), 'container', 'evaluator-prompt.md'),
  'utf-8',
);

const workerEvaluatorPrompt = fs.readFileSync(
  path.join(process.cwd(), 'container', 'worker-evaluator-prompt.md'),
  'utf-8',
);

function getAnthropicClient(): Anthropic | null {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  if (!secrets.ANTHROPIC_API_KEY) {
    logger.warn('No ANTHROPIC_API_KEY found, evaluator disabled');
    return null;
  }
  return new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });
}

interface EvaluatorResponse {
  overall: number;
  dimensions: {
    helpfulness: number;
    accuracy: number;
    reasoning_quality: number;
    tool_selection: number;
    knowledge_application: number;
  };
  reasoning: string;
  skill_assessment: string;
}

interface WorkerEvaluatorResponse {
  overall: number;
  dimensions: {
    task_completion: number;
    accuracy: number;
    reasoning_quality: number;
    decomposition_quality: number;
    knowledge_application: number;
  };
  reasoning: string;
  skill_assessment: string;
}

function buildRolloutMessage(
  runs: ReturnType<typeof getRunsForRollout>,
  allSkills: ReturnType<typeof getActiveSkills>,
): string {
  const sections: string[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const selectedIds = getSkillSelectionsForRun(run.id);
    const selectedNames = allSkills
      .filter((s) => selectedIds.includes(s.id))
      .map((s) => s.name);

    sections.push(`## Turn ${i + 1} of ${runs.length}`);
    sections.push('**User:**');
    sections.push('```');
    sections.push(run.prompt_summary ?? '(no prompt recorded)');
    sections.push('```');
    sections.push('');
    sections.push('**Assistant:**');
    sections.push('```');
    sections.push(run.response_summary ?? '(no response recorded)');
    sections.push('```');

    if (run.tool_calls) {
      try {
        const tools = JSON.parse(run.tool_calls) as Array<{
          name: string;
          input: Record<string, unknown>;
          output: string;
        }>;
        if (tools.length > 0) {
          sections.push('**Tools used:**');
          for (const t of tools) {
            const inputSummary = JSON.stringify(t.input).slice(0, 100);
            sections.push(
              `- ${t.name}(${inputSummary}) → ${t.output.slice(0, 150)}`,
            );
          }
        }
      } catch (err) {
        logger.warn({ runId: run.id, err }, 'Failed to parse tool_calls JSON');
      }
    }

    if (selectedNames.length > 0) {
      sections.push(`**Skills selected:** ${selectedNames.join(', ')}`);
    }
    sections.push('');
  }

  // Available skills
  const availableNames = allSkills.map((s) => s.name);
  sections.push('## Available Skills');
  sections.push(
    availableNames.length > 0
      ? availableNames.join(', ')
      : '(none — cold start)',
  );

  return sections.join('\n');
}

function buildWorkerRolloutMessage(
  runs: ReturnType<typeof getRunsForRollout>,
): string {
  const sections: string[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    sections.push(`## Worker Task ${i + 1} of ${runs.length}`);
    sections.push('**Task Description:**');
    sections.push('```');
    sections.push(run.prompt_summary ?? '(no description recorded)');
    sections.push('```');
    sections.push('');
    sections.push(`**Status:** ${run.status}`);
    sections.push('**Result:**');
    sections.push('```');
    sections.push(run.response_summary ?? '(no result recorded)');
    sections.push('```');
    if (
      run.root_outcome_score !== null &&
      run.root_outcome_score !== undefined
    ) {
      sections.push(
        `**Root Outcome Score:** ${(run.root_outcome_score as number).toFixed(2)} (synthesis quality)`,
      );
    }
    sections.push('');
  }

  return sections.join('\n');
}

async function evaluateRollout(
  client: Anthropic,
  rolloutId: string,
  groupFolder: string,
): Promise<EvaluatorResponse | null> {
  const runs = getRunsForRollout(rolloutId);
  if (runs.length === 0) return null;

  const allSkills = getActiveSkills(groupFolder);
  const userMessage = buildRolloutMessage(runs, allSkills);

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 600,
        system: evaluatorPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('evaluator_timeout')), 30000),
      ),
    ]);

    // Fix 1: Validate response structure before accessing content[0]
    if (
      !response.content ||
      response.content.length === 0 ||
      response.content[0].type !== 'text'
    ) {
      logger.warn(
        { rolloutId },
        'Evaluator response missing or non-text content[0], skipping',
      );
      return null;
    }

    const text = response.content[0].text;
    const cleaned = text
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    const result = JSON.parse(cleaned) as EvaluatorResponse;

    // Fix 2: Validate parsed JSON structure
    if (
      typeof result.overall !== 'number' ||
      result.overall < 0 ||
      result.overall > 1 ||
      typeof result.dimensions !== 'object' ||
      result.dimensions === null ||
      typeof result.reasoning !== 'string'
    ) {
      logger.error(
        { rolloutId, rawResponse: cleaned.slice(0, 200) },
        'Evaluator response failed schema validation',
      );
      return null;
    }

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Fix 3: Treat timeout and rate-limit as warn (will retry next poll)
    if (
      errMsg === 'evaluator_timeout' ||
      (typeof (err as { status?: number }).status === 'number' &&
        (err as { status: number }).status === 429)
    ) {
      logger.warn(
        { err, rolloutId },
        'Evaluator API call timed out or rate-limited, will retry',
      );
      return null;
    }
    logger.error({ err, rolloutId }, 'Evaluator API call failed');
    return null;
  }
}

async function evaluateWorkerRolloutTree(
  client: Anthropic,
  rolloutId: string,
  groupFolder: string,
): Promise<WorkerEvaluatorResponse | null> {
  const runs = getRunsForRollout(rolloutId);
  if (runs.length === 0) return null;

  const userMessage = buildWorkerRolloutMessage(runs);

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: workerEvaluatorPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('evaluator_timeout')), 30000),
      ),
    ]);

    if (
      !response.content ||
      response.content.length === 0 ||
      response.content[0].type !== 'text'
    ) {
      logger.warn(
        { rolloutId },
        'Worker evaluator response missing or non-text content[0], skipping',
      );
      return null;
    }

    const text = response.content[0].text;
    const cleaned = text
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    const result = JSON.parse(cleaned) as WorkerEvaluatorResponse;

    if (
      typeof result.overall !== 'number' ||
      result.overall < 0 ||
      result.overall > 1 ||
      typeof result.dimensions !== 'object' ||
      result.dimensions === null ||
      typeof result.reasoning !== 'string'
    ) {
      logger.error(
        { rolloutId, rawResponse: cleaned.slice(0, 200) },
        'Worker evaluator response failed schema validation',
      );
      return null;
    }

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg === 'evaluator_timeout' ||
      (typeof (err as { status?: number }).status === 'number' &&
        (err as { status: number }).status === 429)
    ) {
      logger.warn(
        { err, rolloutId },
        'Worker evaluator API call timed out or rate-limited, will retry',
      );
      return null;
    }
    logger.error({ err, rolloutId }, 'Worker evaluator API call failed');
    return null;
  }
}

/**
 * Score a worker task tree synthesis and close its rollout.
 * Called from index.ts after the synthesis message is sent to the user.
 */
export async function scoreAndCloseWorkerRollout(
  rootTaskId: string,
  taskDescription: string,
  synthesisText: string,
): Promise<void> {
  const client = getAnthropicClient();
  if (!client) return;

  // Close rollout first so it's ready for evaluation
  closeWorkerRollout(rootTaskId);

  // Score the synthesis: simple prompt asking how good the output was
  const scoringMessage = [
    '## Task Description',
    '```',
    taskDescription.slice(0, 500),
    '```',
    '',
    '## Synthesis Delivered to User',
    '```',
    synthesisText.slice(0, 1000),
    '```',
  ].join('\n');

  const scoringSystem = `You are scoring the quality of a task synthesis message delivered to a user.
Return ONLY a JSON object with a single field: {"overall": 0.0-1.0}
- 0.9-1.0: Excellent — clear, complete, directly answers the task
- 0.7-0.9: Good — useful but minor gaps
- 0.5-0.7: Adequate — partially useful
- 0.3-0.5: Poor — vague or incomplete
- 0.0-0.3: Failed — does not address the task`;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: scoringSystem,
        messages: [{ role: 'user', content: scoringMessage }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('synthesis_score_timeout')), 20000),
      ),
    ]);

    if (
      response.content &&
      response.content.length > 0 &&
      response.content[0].type === 'text'
    ) {
      const text = response.content[0].text;
      const cleaned = text
        .replace(/^```json?\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned) as { overall: number };
      if (
        typeof parsed.overall === 'number' &&
        parsed.overall >= 0 &&
        parsed.overall <= 1
      ) {
        updateRootOutcomeScore(rootTaskId, parsed.overall);
        logger.info(
          { rootTaskId, score: parsed.overall },
          'Root outcome score recorded',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { rootTaskId, err },
      'Failed to score synthesis, skipping root outcome score',
    );
  }
}

async function processEvaluations(): Promise<void> {
  // Close any stale open rollouts first
  closeStaleRollouts();

  const client = getAnthropicClient();
  if (!client) return;

  const rollouts = getClosedRolloutsNeedingEvaluation();
  if (rollouts.length === 0) return;

  logger.info(
    { count: rollouts.length },
    'Processing pending rollout evaluations',
  );

  for (const rollout of rollouts) {
    try {
      const result = await evaluateRollout(
        client,
        rollout.id,
        rollout.group_folder,
      );
      if (!result) continue;

      const runs = getRunsForRollout(rollout.id);
      const now = new Date().toISOString();

      // Record evaluation against each run in the rollout with the same score
      const skillIds = new Set<string>();
      for (const run of runs) {
        const evalId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        recordEvaluation({
          id: evalId,
          run_id: run.id,
          score: result.overall,
          dimensions: JSON.stringify(result.dimensions),
          evaluation_source: 'evaluator_agent',
          evaluator_reasoning: result.reasoning,
          raw_feedback: JSON.stringify({
            skill_assessment: result.skill_assessment,
          }),
          evaluated_at: now,
        });

        // Collect all skill IDs used across the rollout
        for (const sid of getSkillSelectionsForRun(run.id)) {
          skillIds.add(sid);
        }
      }

      // Update performance for all skills that participated in this rollout
      for (const skillId of skillIds) {
        updateSkillPerformance(skillId);
      }

      logger.info(
        { rolloutId: rollout.id, turns: runs.length, score: result.overall },
        'Rollout evaluation recorded',
      );
    } catch (err) {
      logger.error({ err, rolloutId: rollout.id }, 'Error evaluating rollout');
    }
  }

  // Process worker rollouts
  const workerRollouts = getClosedWorkerRolloutsNeedingEvaluation();
  if (workerRollouts.length > 0) {
    logger.info(
      { count: workerRollouts.length },
      'Processing pending worker rollout evaluations',
    );
  }

  for (const rollout of workerRollouts) {
    try {
      const result = await evaluateWorkerRolloutTree(
        client,
        rollout.id,
        rollout.group_folder,
      );
      if (!result) continue;

      const runs = getRunsForRollout(rollout.id);
      const now = new Date().toISOString();

      for (const run of runs) {
        const evalId = `weval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        recordEvaluation({
          id: evalId,
          run_id: run.id,
          score: result.overall,
          dimensions: JSON.stringify(result.dimensions),
          evaluation_source: 'evaluator_agent',
          evaluator_reasoning: result.reasoning,
          raw_feedback: JSON.stringify({
            skill_assessment: result.skill_assessment,
          }),
          evaluated_at: now,
        });
      }

      logger.info(
        {
          rolloutId: rollout.id,
          tasks: runs.length,
          score: result.overall,
        },
        'Worker rollout evaluation recorded',
      );
    } catch (err) {
      logger.error(
        { err, rolloutId: rollout.id },
        'Error evaluating worker rollout',
      );
    }
  }
}

export function startEvaluationLoop(): void {
  if (evaluatorRunning) {
    logger.debug('Evaluation loop already running, skipping duplicate start');
    return;
  }
  evaluatorRunning = true;

  const poll = async () => {
    try {
      await processEvaluations();
    } catch (err) {
      logger.error({ err }, 'Error in evaluation loop');
    }
    setTimeout(poll, EVALUATION_POLL_INTERVAL);
  };

  setTimeout(poll, 30_000);
  logger.info('Evaluation loop started');
}
