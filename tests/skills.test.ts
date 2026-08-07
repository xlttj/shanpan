import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeSkills } from '../src/cli/commands/init.js';
import { SKILLS } from '../src/skills/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-skills-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const skillsBase = () => path.join(tmpDir, '.claude', 'skills');

describe('writeSkills', () => {
  it('writes exactly the current skill set to .claude/skills', () => {
    writeSkills(tmpDir);
    const dirs = fs.readdirSync(skillsBase()).sort();
    expect(dirs).toEqual(SKILLS.map((s) => s.name).sort());
  });

  it('tags each generated skill so it can be recognised later', () => {
    writeSkills(tmpDir);
    for (const skill of SKILLS) {
      const content = fs.readFileSync(path.join(skillsBase(), skill.name, 'SKILL.md'), 'utf-8');
      expect(content).toContain('<!-- shanpan-managed-skill -->');
    }
  });

  it('prunes a shanpan-owned skill that is no longer shipped', () => {
    // Simulate a skill left behind by an earlier version.
    const stale = path.join(skillsBase(), 'create-spec');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(
      path.join(stale, 'SKILL.md'),
      '---\nname: create-spec\n---\n# old\n\n<!-- shanpan-managed-skill -->\n',
    );

    writeSkills(tmpDir);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(skillsBase()).sort()).toEqual(SKILLS.map((s) => s.name).sort());
  });

  it('never deletes a hand-written skill it does not own', () => {
    const userSkill = path.join(skillsBase(), 'my-own-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '---\nname: my-own-skill\n---\n# mine\n');

    writeSkills(tmpDir);

    expect(fs.existsSync(userSkill)).toBe(true);
  });

  it('leaves an unrelated directory without a SKILL.md alone', () => {
    const junk = path.join(skillsBase(), 'not-a-skill');
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(junk, 'README.md'), 'nothing here');

    writeSkills(tmpDir);

    expect(fs.existsSync(junk)).toBe(true);
  });

  it('writes to .cursor when that client dir exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    const written = writeSkills(tmpDir);
    expect(written).toContain(path.join('.claude', 'skills'));
    expect(written).toContain(path.join('.cursor', 'skills'));
    expect(written).not.toContain(path.join('.opencode', 'skills'));
  });

  it('writes to .opencode when opencode.json exists even without .opencode/', () => {
    fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}');
    const written = writeSkills(tmpDir);
    expect(written).toContain(path.join('.opencode', 'skills'));
  });
});
