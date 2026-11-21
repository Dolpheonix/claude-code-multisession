import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Finds Claude Code skills and custom slash commands on disk.
 *
 * Locations (documented by Claude Code):
 *  - personal  ~/.claude/skills/<name>/SKILL.md
 *  - project   <folder>/.claude/skills/<name>/SKILL.md
 *  - commands  ~/.claude/commands/**.md, <folder>/.claude/commands/**.md (older custom-command format)
 *  - plugin    skills/<name>/SKILL.md inside installed plugins under ~/.claude/plugins
 *  - synced    ~/.claude/skills/synced/<bucket>/<name>/SKILL.md: claude.ai account skills, managed by sync
 * Plugin and synced skills are overwritten by updates, so they are shown as read-only.
 */

export type SkillSource = 'project' | 'personal' | 'command' | 'plugin' | 'synced';

export interface SkillInfo {
  /** Name as invoked, e.g. "deploy", "review/pr" (nested command), "my-plugin:lint". */
  name: string;
  description?: string;
  source: SkillSource;
  /** The SKILL.md (or command .md) file. */
  file: string;
  /** Project folder (project skills/commands) or plugin name. */
  scope?: string;
  /** Project skills: the workspace folder they belong to. */
  folder?: string;
  /** Plugin skills from the plugin cache: the `enabledPlugins` key, "<plugin>@<marketplace>". */
  pluginId?: string;
  /** Plugin manifest `defaultEnabled` (true unless the manifest says false). */
  pluginDefaultEnabled?: boolean;
  readOnly: boolean;
}

export const claudeHome = () => path.join(os.homedir(), '.claude');
const MAX_PLUGIN_DEPTH = 6;

export function scanSkills(workspaceFolders: string[]): SkillInfo[] {
  const home = claudeHome();
  const out: SkillInfo[] = [];
  for (const folder of workspaceFolders) {
    const base = path.join(folder, '.claude');
    const own = [
      ...skillDirs(path.join(base, 'skills'), 'project', path.basename(folder)),
      ...commandFiles(path.join(base, 'commands'), path.basename(folder)),
    ];
    own.forEach((s) => (s.folder = folder));
    out.push(...own);
  }
  out.push(...skillDirs(path.join(home, 'skills'), 'personal'));
  out.push(...commandFiles(path.join(home, 'commands')));
  for (const bucket of readdir(path.join(home, 'skills', 'synced'))) {
    out.push(...skillDirs(path.join(home, 'skills', 'synced', bucket), 'synced'));
  }
  out.push(...pluginSkills(path.join(home, 'plugins')));
  return out;
}

/** `<dir>/<name>/SKILL.md` for each subfolder. Folders starting with "." and the `synced` area are skipped. */
function skillDirs(dir: string, source: SkillSource, scope?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const entry of readdir(dir)) {
    if (entry.startsWith('.') || (source === 'personal' && entry === 'synced')) {
      continue;
    }
    const file = path.join(dir, entry, 'SKILL.md');
    if (!isFile(file)) {
      continue;
    }
    const fm = readFrontmatter(file);
    const name = fm.name || entry;
    out.push({
      name: source === 'plugin' && scope ? `${scope}:${name}` : name,
      description: fm.description,
      source,
      file,
      scope,
      readOnly: source === 'plugin' || source === 'synced',
    });
  }
  return out;
}

/** Custom commands: every .md under the folder; subfolders become "sub/name". */
function commandFiles(dir: string, scope?: string, prefix = ''): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const entry of readdir(dir)) {
    const p = path.join(dir, entry);
    if (isDir(p)) {
      out.push(...commandFiles(p, scope, `${prefix}${entry}/`));
    } else if (entry.endsWith('.md')) {
      out.push({
        name: prefix + entry.slice(0, -3),
        description: readFrontmatter(p).description,
        source: 'command',
        file: p,
        scope,
        readOnly: false,
      });
    }
  }
  return out;
}

/**
 * Any `skills/` folder inside the plugins area; the plugin name comes from `.claude-plugin/plugin.json`.
 * Installed plugins live in `cache/<marketplace>/<plugin>/<version>/`, which gives the
 * `enabledPlugins` key "<plugin>@<marketplace>".
 */
function pluginSkills(dir: string, depth = 0, root = dir): SkillInfo[] {
  if (depth > MAX_PLUGIN_DEPTH) {
    return [];
  }
  const out: SkillInfo[] = [];
  const entries = readdir(dir);
  if (entries.includes('skills') && isDir(path.join(dir, 'skills'))) {
    const manifest = readManifest(dir);
    const rel = path.relative(path.join(root, 'cache'), dir).split(path.sep);
    const pluginId = rel.length === 3 && !rel[0].startsWith('..') ? `${rel[1]}@${rel[0]}` : undefined;
    for (const s of skillDirs(path.join(dir, 'skills'), 'plugin', manifest.name || path.basename(dir))) {
      s.pluginId = pluginId;
      s.pluginDefaultEnabled = manifest.defaultEnabled !== false;
      out.push(s);
    }
  }
  for (const entry of entries) {
    if (entry !== 'skills' && entry !== 'node_modules' && !entry.startsWith('.') && isDir(path.join(dir, entry))) {
      out.push(...pluginSkills(path.join(dir, entry), depth + 1, root));
    }
  }
  return out;
}

function readManifest(dir: string): { name?: string; defaultEnabled?: boolean } {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    return {
      name: typeof json.name === 'string' && json.name ? json.name : undefined,
      defaultEnabled: typeof json.defaultEnabled === 'boolean' ? json.defaultEnabled : undefined,
    };
  } catch {
    return {}; // no manifest
  }
}

/**
 * The settings that decide whether a skill loads, as Claude Code merges them for sessions started
 * in one folder: user (~/.claude/settings.json) < project (.claude/settings.json) < local
 * (.claude/settings.local.json), key by key. Managed (enterprise) settings are not read.
 *  - `enabledPlugins`: { "<plugin>@<marketplace>": boolean }
 *  - `skillOverrides`: { "<skill>": "off" | "name-only" | "user-invocable-only" } (not for plugin skills)
 */
export interface SkillSettings {
  /** Workspace folder, or undefined for user settings alone (no folder open). */
  folder?: string;
  enabledPlugins: Record<string, boolean>;
  skillOverrides: Record<string, string>;
}

export function loadSkillSettings(workspaceFolders: string[]): SkillSettings[] {
  const user = readSettingsFile(path.join(claudeHome(), 'settings.json'));
  const contexts = workspaceFolders.length > 0 ? workspaceFolders : [undefined];
  return contexts.map((folder) => {
    const layers = [user];
    if (folder) {
      layers.push(
        readSettingsFile(path.join(folder, '.claude', 'settings.json')),
        readSettingsFile(path.join(folder, '.claude', 'settings.local.json')),
      );
    }
    const merged: SkillSettings = { folder, enabledPlugins: {}, skillOverrides: {} };
    for (const l of layers) {
      Object.assign(merged.enabledPlugins, objectOf(l.enabledPlugins));
      Object.assign(merged.skillOverrides, objectOf(l.skillOverrides));
    }
    return merged;
  });
}

export type SkillState =
  | { kind: 'on' }
  | { kind: 'off'; reason: string }
  /** Loads only in some of the open folders. */
  | { kind: 'mixed'; reason: string }
  /** skillOverrides "name-only" / "user-invocable-only". */
  | { kind: 'limited'; mode: string; reason: string };

/** Whether Claude Code loads this skill for sessions in this window's workspace folders. */
export function skillState(skill: SkillInfo, settings: SkillSettings[]): SkillState {
  const relevant = skill.folder ? settings.filter((c) => c.folder === skill.folder) : settings;
  const where = (c: SkillSettings) => (c.folder ? path.basename(c.folder) : 'user settings');
  const modes = relevant.map((c) => ({ where: where(c), mode: modeIn(skill, c) }));
  const offIn = modes.filter((m) => m.mode === 'off').map((m) => m.where);
  const limited = modes.find((m) => m.mode !== 'on' && m.mode !== 'off');
  const pluginKey = skill.pluginId ?? '?';
  const setting = skill.source === 'plugin' ? `enabledPlugins["${pluginKey}"]` : `skillOverrides["${skill.name}"]`;

  if (offIn.length > 0 && offIn.length === relevant.length) {
    const scope = relevant.length === 1 ? ` (${offIn[0]})` : '';
    return { kind: 'off', reason: `Turned off by ${setting}${scope}.` };
  }
  if (offIn.length > 0) {
    return { kind: 'mixed', reason: `Turned off by ${setting} in: ${offIn.join(', ')}.` };
  }
  if (limited) {
    return { kind: 'limited', mode: limited.mode, reason: `${setting} = "${limited.mode}" (${limited.where}).` };
  }
  return { kind: 'on' };
}

/** "on", "off", or a skillOverrides mode such as "name-only", for sessions under one settings context. */
function modeIn(skill: SkillInfo, c: SkillSettings): string {
  if (skill.source === 'plugin') {
    const enabled = skill.pluginId ? c.enabledPlugins[skill.pluginId] : undefined;
    return (enabled ?? skill.pluginDefaultEnabled !== false) ? 'on' : 'off';
  }
  const base = skill.name.slice(skill.name.lastIndexOf(':') + 1);
  const mode = c.skillOverrides[skill.name] ?? c.skillOverrides[base];
  return typeof mode === 'string' && mode ? mode : 'on';
}

function readSettingsFile(file: string): Record<string, unknown> {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {}; // missing or not plain JSON
  }
}

function objectOf(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/**
 * Minimal YAML frontmatter reader for `name` and `description`: plain, quoted, and
 * block (`>` / `|`) scalars. Anything fancier falls back to the raw text.
 */
export function readFrontmatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 16 * 1024);
  } catch {
    return {};
  }
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) {
    return {};
  }
  const lines = m[1].split(/\r?\n/);
  const result: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) {
      continue;
    }
    let value = kv[2].trim();
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = block.join(' ');
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1).replaceAll(value[0] === '"' ? String.raw`\"` : "''", value[0]);
    }
    result[kv[1]] = value;
  }
  return { name: result.name || undefined, description: result.description || undefined };
}

/** Valid skill names: lowercase letters, digits and hyphens (Claude Code's rule for `name`). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Creates `<skillsDir>/<name>/SKILL.md` from a template and returns its path. */
export function createSkill(skillsDir: string, name: string, description: string): string {
  const dir = path.join(skillsDir, name);
  if (fs.existsSync(dir)) {
    throw new Error(`${dir} already exists`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const desc = description.includes(':') || description.includes('#') ? JSON.stringify(description) : description;
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nInstructions for Claude go here.\n`,
    { flag: 'wx' },
  );
  return file;
}

/**
 * Copies a skill folder (SKILL.md plus any supporting files) into `destRoot/<name>`.
 * Returns 'same' when every file is already identical (nothing written).
 */
export function installSkillFolder(srcDir: string, destRoot: string): { dest: string; result: 'created' | 'updated' | 'same' } {
  const dest = path.join(destRoot, path.basename(srcDir));
  const existed = fs.existsSync(dest);
  const files = listFiles(srcDir);
  const same = existed && files.every((rel) => sameFile(path.join(srcDir, rel), path.join(dest, rel)));
  if (same) {
    return { dest, result: 'same' };
  }
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), path.join(dest, rel));
  }
  return { dest, result: existed ? 'updated' : 'created' };
}

/** Whether `destRoot/<name>` exists and differs from the source (an install would overwrite something). */
export function skillFolderDiffers(srcDir: string, destRoot: string): boolean {
  const dest = path.join(destRoot, path.basename(srcDir));
  return fs.existsSync(dest) && !listFiles(srcDir).every((rel) => sameFile(path.join(srcDir, rel), path.join(dest, rel)));
}

function listFiles(dir: string, prefix = ''): string[] {
  return readdir(path.join(dir, prefix)).flatMap((e) => {
    const rel = path.join(prefix, e);
    return isDir(path.join(dir, rel)) ? listFiles(dir, rel) : [rel];
  });
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
