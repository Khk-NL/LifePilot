import { z } from 'zod';
import { day, entities, id, instant, uid } from './model';

type Kind = keyof typeof entities;
type Data<K extends Kind> = z.infer<(typeof entities)[K]>;

const entry = z.strictObject({
  schema: z.literal(1), kind: z.enum(['day', 'week', 'rubric', 'proposal', 'sections']), key: z.string(),
  id, parents: z.array(id).max(200), at: instant, data: z.unknown()
});
type Entry = z.infer<typeof entry>;
export type Revision<K extends Kind> = Omit<Entry, 'kind' | 'data'> & { kind: K; data: Data<K> };

export interface Files {
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  publish(path: string, body: string): Promise<void>;
}

function keyFor(kind: Kind, value: string) {
  if ((kind === 'rubric' || kind === 'sections') && value === 'active') return value;
  return (kind === 'proposal' ? id : day).parse(value);
}

function note(value: Entry) {
  return `---\nlifepilot_schema: 1\nlifepilot_kind: ${value.kind}\nlifepilot_key: "${value.key}"\n---\n\n# LifePilot · ${value.key}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function parse(body: string, kind: Kind, key: string, revisionId: string): Entry {
  const payload = /^\x60{3}json\r?\n([\s\S]+?)\r?\n\x60{3}[ \t]*$/m.exec(body)?.[1];
  if (!payload) throw Error('缺少 LifePilot 修订内容');
  const value = entry.parse(JSON.parse(payload));
  if (value.kind !== kind || value.key !== key || value.id !== revisionId)
    throw Error('修订标识与文件路径不一致');
  if (value.parents.includes(value.id) || new Set(value.parents).size !== value.parents.length)
    throw Error('无效父修订');
  const data = entities[kind].parse(value.data);
  if (('date' in data && kind === 'day' && data.date !== key) || ('monday' in data && data.monday !== key))
    throw Error('实体日期与文件路径不一致');
  return { ...value, data };
}

export class Store {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly files: Files) {}

  async keys(kind: Kind): Promise<string[]> {
    const files = await this.files.list(kind);
    return [...new Set(files.map(name => name.split('--')[0]).filter(key => {
      try { return keyFor(kind, key) === key; } catch { return false; }
    }))].sort();
  }

  async inspect<K extends Kind>(kind: K, rawKey: string) {
    const key = keyFor(kind, rawKey);
    const names = (await this.files.list(kind)).filter(name => name.startsWith(key + '--') && name.endsWith('.md'));
    const revisions: Revision<K>[] = [];
    const issues: string[] = [];
    for (const name of names) {
      try {
        const revisionId = name.slice(key.length + 2, -3);
        revisions.push(parse(await this.files.read(kind + '/' + name), kind, key, revisionId) as Revision<K>);
      } catch {
        issues.push(name);
      }
    }
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    const parents = new Set(revisions.flatMap(revision => revision.parents));
    for (const missing of parents) if (!byId.has(missing)) issues.push('等待父修订 ' + missing);
    const heads = revisions.filter(revision => !parents.has(revision.id));
    const reached = new Set<string>();
    const queue = heads.map(head => head.id);
    while (queue.length) {
      const current = queue.pop()!;
      if (reached.has(current)) continue;
      reached.add(current);
      queue.push(...(byId.get(current)?.parents ?? []));
    }
    if (revisions.some(r => !reached.has(r.id))) issues.push('修订链异常');
    return { heads, issues, revisions };
  }

  async current<K extends Kind>(kind: K, key: string): Promise<Revision<K> | undefined> {
    const { heads, issues } = await this.inspect(kind, key);
    if (issues.length || heads.length > 1) throw Error(`${kind}/${key} 存在冲突或缺失修订，请先处理同步状态`);
    return heads[0];
  }

  save<K extends Kind>(kind: K, key: string, data: Data<K>, expected: string[], revisionId = uid()): Promise<string> {
    const saving = this.writing.then(() => this.append(kind, key, data, expected, revisionId));
    this.writing = saving.catch(() => undefined);
    return saving;
  }

  private async append<K extends Kind>(kind: K, key: string, data: Data<K>, expected: string[], revisionId: string) {
    keyFor(kind, key);
    id.parse(revisionId);
    const state = await this.inspect(kind, key);
    const next = { schema: 1 as const, kind, key, id: revisionId, parents: expected, at: new Date().toISOString(), data };
    const body = note(next);
    parse(body, kind, key, revisionId);
    const prior = state.revisions.find(r => r.id === revisionId);
    if (prior && JSON.stringify(prior.data) === JSON.stringify(entities[kind].parse(data))) return revisionId;
    if (prior || state.issues.length || state.heads.map(h => h.id).sort().join() !== [...expected].sort().join())
      throw Error('记录已更新或存在冲突，请刷新后重试');
    await this.files.publish(`${kind}/${key}--${revisionId}.md`, body);
    return revisionId;
  }

  async resolve<K extends Kind>(kind: K, key: string, chosen: string, expected: string[]) {
    const state = await this.inspect(kind, key);
    const revision = state.heads.find(candidate => candidate.id === chosen);
    if (!revision || state.heads.length < 2) throw Error('冲突已变化，请刷新');
    return this.save(kind, key, revision.data, expected);
  }

  async backup() {
    const files: Record<string, string> = {};
    for (const kind of Object.keys(entities) as Kind[]) {
      for (const name of (await this.files.list(kind)).filter(n => n.endsWith('.md')))
        files[kind + '/' + name] = await this.files.read(kind + '/' + name);
    }
    return { schema: 1, files };
  }

  async restore(input: unknown) {
    const backup = z.strictObject({ schema: z.literal(1), files: z.record(z.string(), z.string()) }).parse(input);
    const writes: [string, string][] = [];
    for (const [path, body] of Object.entries(backup.files)) {
      const match = /^(day|week|rubric|proposal|sections)\/([^/]+?)--([a-f\d-]{36})\.md$/.exec(path);
      if (!match) throw Error('无效备份路径');
      const [, rawKind, key, revisionId] = match;
      const kind = rawKind as Kind;
      const incoming = parse(body, kind, keyFor(kind, key), revisionId);
      if ((await this.files.list(kind)).includes(path.split('/')[1])) {
        const old = parse(await this.files.read(path), kind, key, revisionId);
        if (JSON.stringify(old) !== JSON.stringify(incoming)) throw Error('同一修订 ID 已存在不同内容');
      } else {
        writes.push([path, body]);
      }
    }
    for (const [path, body] of writes) await this.files.publish(path, body);
    return writes.length;
  }
}
