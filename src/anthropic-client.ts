import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export function getAnthropicClient(): Anthropic | null {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  if (!secrets.ANTHROPIC_API_KEY) {
    logger.warn('No ANTHROPIC_API_KEY found, Anthropic features disabled');
    return null;
  }
  return new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });
}

/**
 * Load a prompt file from the container/ directory.
 * Cached after first read.
 */
const promptCache = new Map<string, string>();

export function loadPrompt(filename: string): string {
  if (promptCache.has(filename)) return promptCache.get(filename)!;
  const content = fs.readFileSync(
    path.join(process.cwd(), 'container', filename),
    'utf-8',
  );
  promptCache.set(filename, content);
  return content;
}
