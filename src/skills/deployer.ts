/**
 * Skill Deployer
 * Reads active skills from DB, strips evolution notes, writes SKILL.md files
 * to .claude/skills/ in Claude Code's native skill format.
 */
import fs from 'fs';
import path from 'path';

import { getActiveSkills } from '../db.js';
import { logger } from '../logger.js';

const MANIFEST_FILENAME = '_behavioral-manifest.json';

/**
 * Strip HTML-comment evolution notes from skill content.
 * The task agent should not see these — only the evolution agent uses them.
 */
export function stripEvolutionNotes(content: string): string {
  return content.replace(/<!--\s*EVOLUTION_NOTES[\s\S]*?-->/g, '').trim();
}

/**
 * Deploy behavioral skills from DB as Claude Code native SKILL.md files.
 * Called before each container spawn.
 *
 * Writes to {skillsDir}/{skill.name}/SKILL.md with YAML frontmatter
 * so Claude Code auto-discovers them alongside built-in skills.
 */
export function deploySkillFiles(groupFolder: string, skillsDir: string): void {
  fs.mkdirSync(skillsDir, { recursive: true });

  // Read manifest of previously deployed behavioral skill directories
  const manifestPath = path.join(skillsDir, MANIFEST_FILENAME);
  let previousDirs: string[] = [];
  try {
    if (fs.existsSync(manifestPath)) {
      previousDirs = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
  } catch {
    // Corrupted manifest — will be overwritten
  }

  // Collect built-in skill directory names to detect collisions
  const builtInDirs = new Set<string>();
  try {
    for (const entry of fs.readdirSync(skillsDir)) {
      if (previousDirs.includes(entry)) continue; // skip our own
      if (entry === MANIFEST_FILENAME) continue;
      const stat = fs.statSync(path.join(skillsDir, entry));
      if (stat.isDirectory()) {
        builtInDirs.add(entry);
      }
    }
  } catch {
    // skillsDir may not exist yet
  }

  // Clean up previously deployed behavioral skill directories
  for (const dir of previousDirs) {
    const dirPath = path.join(skillsDir, dir);
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Already gone
    }
  }

  const skills = getActiveSkills(groupFolder);
  const deployedDirs: string[] = [];

  for (const skill of skills) {
    // Check for name collision with built-in skills
    if (builtInDirs.has(skill.name)) {
      logger.warn(
        { skillName: skill.name, groupFolder },
        'Behavioral skill name collides with built-in skill, skipping',
      );
      continue;
    }

    const stripped = stripEvolutionNotes(skill.content);
    const skillDir = path.join(skillsDir, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });

    const skillContent = `---
name: ${skill.name}
description: ${skill.description}
---

${stripped}`;

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);
    deployedDirs.push(skill.name);
  }

  // Write updated manifest
  fs.writeFileSync(manifestPath, JSON.stringify(deployedDirs, null, 2));

  logger.debug(
    { groupFolder, skillCount: deployedDirs.length },
    'Deployed behavioral skill files',
  );
}
