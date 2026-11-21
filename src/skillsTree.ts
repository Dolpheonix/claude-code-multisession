import * as path from 'path';
import * as vscode from 'vscode';
import { Session, SessionStore } from './sessionStore';
import { loadSkillSettings, scanSkills, SkillInfo, SkillSettings, SkillSource, skillState } from './skills';
import { GatedTreeProvider, timeAgo } from './treeViews';
import { isInWorkspace, sessionLabel, visibleSessions } from './viewModel';

/** How a skill was used across the loaded sessions (lookback window). */
export interface SkillUsage {
  count: number;
  lastTs: number;
  sessions: Session[];
}

export type SkillNode =
  | { type: 'group'; key: string; label: string; icon: string; skills: SkillInfo[] }
  | { type: 'skill'; skill: SkillInfo }
  /** Invoked through the Skill tool but not found on disk (bundled with Claude Code, or removed). */
  | { type: 'unlisted'; name: string };

const GROUPS: { source: SkillSource; label: string; icon: string }[] = [
  { source: 'project', label: 'Project', icon: 'repo' },
  { source: 'personal', label: 'Personal', icon: 'account' },
  { source: 'command', label: 'Custom commands', icon: 'terminal' },
  { source: 'plugin', label: 'Plugins', icon: 'extensions' },
  { source: 'synced', label: 'claude.ai (synced)', icon: 'cloud' },
];

/** Skills on disk, grouped by where they live, with how often sessions used them. */
export class SkillsTreeProvider extends GatedTreeProvider<SkillNode> {
  private skills: SkillInfo[] = [];
  private settings: SkillSettings[] = [];

  constructor(store: SessionStore) {
    super(store);
    this.rescan();
  }

  /** Re-read the skill folders (on file changes or the refresh button). */
  rescan(): void {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.skills = scanSkills(folders);
    this.settings = loadSkillSettings(folders);
    this.refresh();
  }

  /**
   * name as used in transcripts -> usage. Plugin/synced skills may be used with a "prefix:" namespace.
   * By default only sessions of this window's workspace (cwd in or under an open folder) count,
   * since those are the ones that can load the skills listed here.
   */
  usage(allWorkspaces = false): Map<string, SkillUsage> {
    const out = new Map<string, SkillUsage>();
    for (const s of visibleSessions(this.store).filter((x) => allWorkspaces || isInWorkspace(x))) {
      for (const [name, u] of s.skills) {
        const agg = out.get(name) ?? { count: 0, lastTs: 0, sessions: [] };
        agg.count += u.count;
        agg.lastTs = Math.max(agg.lastTs, u.lastTs);
        agg.sessions.push(s);
        out.set(name, agg);
      }
    }
    return out;
  }

  usageOf(skill: SkillInfo, usage = this.usage()): SkillUsage | undefined {
    const matches = [...usage.entries()].filter(([name]) => matchesSkill(name, skill)).map(([, u]) => u);
    if (matches.length === 0) {
      return undefined;
    }
    return {
      count: matches.reduce((n, u) => n + u.count, 0),
      lastTs: Math.max(...matches.map((u) => u.lastTs)),
      sessions: [...new Set(matches.flatMap((u) => u.sessions))],
    };
  }

  protected signature(): string {
    const usage = [...this.usage(true).entries()]
      .map(([n, u]) => `${n}=${u.count}/${u.sessions.filter((x) => isInWorkspace(x)).length}`)
      .sort()
      .join(',');
    return this.skills.map((s) => s.file).join('|') + '#' + usage;
  }

  getChildren(node?: SkillNode): SkillNode[] {
    if (!node) {
      return this.rootNodes();
    }
    if (node.type !== 'group') {
      return [];
    }
    if (node.key === 'unlisted') {
      return this.unlisted().map((name) => ({ type: 'unlisted', name }));
    }
    const usage = this.usage();
    const count = (s: SkillInfo) => this.usageOf(s, usage)?.count ?? 0;
    return [...node.skills]
      .sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name))
      .map((skill) => ({ type: 'skill', skill }));
  }

  private rootNodes(): SkillNode[] {
    const nodes: SkillNode[] = [];
    for (const g of GROUPS) {
      const skills = this.skills.filter((s) => s.source === g.source);
      if (g.source === 'project') {
        // One group per workspace folder that has project skills or commands.
        for (const scope of new Set(skills.map((s) => s.scope ?? ''))) {
          const label = `${g.label} · ${scope}`;
          nodes.push({ type: 'group', key: `project:${scope}`, label, icon: g.icon, skills: skills.filter((s) => (s.scope ?? '') === scope) });
        }
      } else if (skills.length > 0) {
        nodes.push({ type: 'group', key: g.source, label: g.label, icon: g.icon, skills });
      }
    }
    if (this.unlisted().length > 0) {
      nodes.push({ type: 'group', key: 'unlisted', label: 'Used, not on disk', icon: 'question', skills: [] });
    }
    return nodes;
  }

  /**
   * Names Claude invoked via the Skill tool in this workspace's sessions that match no skill on disk
   * (e.g. skills bundled with Claude Code). Other workspaces are skipped: their project skills are not listed here.
   */
  private unlisted(): string[] {
    const names = new Set<string>();
    for (const s of visibleSessions(this.store).filter((x) => isInWorkspace(x))) {
      for (const [name, u] of s.skills) {
        if (u.viaTool && !this.skills.some((k) => matchesSkill(name, k))) {
          names.add(name);
        }
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  getTreeItem(node: SkillNode): vscode.TreeItem {
    if (node.type === 'group') {
      const n = node.key === 'unlisted' ? this.unlisted().length : node.skills.length;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.key}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.description = String(n);
      return item;
    }
    if (node.type === 'unlisted') {
      const u = this.usage().get(node.name);
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.id = `unlisted:${node.name}`;
      item.iconPath = new vscode.ThemeIcon('sparkle');
      item.description = u ? `${u.count}× · ${timeAgo(u.lastTs)}` : '';
      item.tooltip = usageTooltip(
        new vscode.MarkdownString(`**${node.name}**\n\nNo SKILL.md found (bundled with Claude Code, or removed).\n\n`),
        u,
        this.usage(true).get(node.name),
      );
      return item;
    }
    return this.skillItem(node.skill);
  }

  private skillItem(skill: SkillInfo): vscode.TreeItem {
    const u = this.usageOf(skill);
    const state = skillState(skill, this.settings);
    const item = new vscode.TreeItem(skill.source === 'command' ? `/${skill.name}` : skill.name, vscode.TreeItemCollapsibleState.None);
    item.id = `skill:${skill.file}`;
    item.iconPath =
      state.kind === 'off'
        ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
        : new vscode.ThemeIcon(skill.source === 'command' ? 'terminal' : 'sparkle');
    const stateLabel = { on: '', off: 'off', mixed: 'off in some folders', limited: state.kind === 'limited' ? state.mode : '' }[state.kind];
    item.description = [stateLabel && `[${stateLabel}]`, u ? `${u.count}×` : '', skill.readOnly ? '🔒' : '', skill.description ?? '']
      .filter(Boolean)
      .join(' ');
    item.contextValue = skill.readOnly ? 'skill.readonly' : 'skill';
    item.resourceUri = vscode.Uri.file(skill.file);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(skill.file)] };

    const md = new vscode.MarkdownString(`**${skill.name}**${skill.scope ? ` · ${skill.scope}` : ''}\n\n`);
    if (skill.description) {
      md.appendText(skill.description + '\n\n');
    }
    md.appendMarkdown(`\`${skill.file}\`\n\n`);
    if (state.kind !== 'on') {
      md.appendMarkdown(`⛔ ${state.reason}\n\n`);
    }
    if (skill.readOnly) {
      md.appendMarkdown(`🔒 Managed by ${skill.source === 'plugin' ? 'the plugin' : 'claude.ai sync'}: edits are overwritten on the next update.\n\n`);
    }
    item.tooltip = usageTooltip(md, u, this.usageOf(skill, this.usage(true)));
    return item;
  }
}

/** `u`: this workspace's sessions; `all`: every loaded session, shown as a total for comparison. */
function usageTooltip(md: vscode.MarkdownString, u: SkillUsage | undefined, all: SkillUsage | undefined): vscode.MarkdownString {
  const total = all ? `All workspaces: ${all.count}× in ${all.sessions.length} session(s).` : '';
  if (!u) {
    md.appendMarkdown(`_Not used in this workspace's sessions._${total ? ` ${total}` : ''}`);
    return md;
  }
  md.appendMarkdown(`This workspace: used ${u.count}× in ${u.sessions.length} session(s), last ${timeAgo(u.lastTs)}:\n\n`);
  for (const s of [...u.sessions].sort((a, b) => b.lastTs - a.lastTs).slice(0, 5)) {
    md.appendText(`• ${sessionLabel(s)}\n`);
  }
  if (u.sessions.length > 5) {
    md.appendText(`• … ${u.sessions.length - 5} more\n`);
  }
  if (all && all.count !== u.count) {
    md.appendMarkdown(`\n${total}`);
  }
  return md;
}

/**
 * Whether a name from a transcript refers to this skill. Plugin and account skills can be invoked
 * with a namespace ("anthropic-skills:docx"), so compare the part after the last ":" too.
 * Command names are compared as typed ("review/pr" vs. Claude Code's "review:pr" both match).
 */
export function matchesSkill(usedName: string, skill: SkillInfo): boolean {
  const norm = (n: string) => n.toLowerCase().replaceAll('/', ':');
  const used = norm(usedName);
  const name = norm(skill.name);
  if (used === name) {
    return true;
  }
  const base = (n: string) => n.slice(n.lastIndexOf(':') + 1);
  return (skill.source === 'plugin' || skill.source === 'synced') && base(used) === base(name);
}

export function skillFolder(skill: SkillInfo): string {
  return skill.source === 'command' ? skill.file : path.dirname(skill.file);
}
