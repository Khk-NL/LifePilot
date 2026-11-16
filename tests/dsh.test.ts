import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { Store, type Files } from '../packages/core/store';
import { prepare, decide } from '../packages/core/service';
import { lifeDate } from '../packages/core/time';
import { uid } from '../packages/core/model';

test('stdio 读取隔离业务数据、提案批准、权限边界和持久提醒去重', async t => {
  const dir = resolve('work');
  await mkdir(dir, { recursive: true });
  const scratch = await mkdtemp(join(dir, 'mcp-'));
  const root = join(scratch, 'LifePilot', 'Data');
  const state = join(scratch, 'ReminderState');
  await mkdir(root, { recursive: true });
  const journal = join(scratch, 'LifePilot', 'Journal.md');
  await writeFile(journal, 'PRIVATE_JOURNAL_SENTINEL');
  const files: Files = {
    list: async d => readdir(join(root, d)).catch(error => { if (error.code !== 'ENOENT') throw error; return []; }),
    read: p => readFile(join(root, p), 'utf8'),
    publish: async (p, body) => {
      await mkdir(join(root, p.split('/')[0]), { recursive: true });
      await writeFile(join(root, p), body, { flag: 'wx' });
    }
  };
  const store = new Store(files);
  const date = lifeDate();
  const initial = await prepare(store, date);
  await store.save('day', date, { ...initial.data, routine: { commitments: 'PRIVATE_SCHEDULE_SENTINEL' }, reminders: [
    { id: uid(), title: '测试提醒', due: new Date(Date.now() - 1000).toISOString(), enabled: true }
  ] }, [initial.id]);
  const entry = join(scratch, 'main.mjs');
  await build({ entryPoints: ['plugins/dsh/main.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry });
  async function connect(writes: boolean) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--root', root,
      ...(writes ? ['--proposals', '--reminder-state', state] : [])], stderr: 'pipe' });
    const client = new Client({ name: 'lifepilot-test', version: '1.0.0' });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  }
  const readonly = await connect(false);
  assert.deepEqual((await readonly.listTools()).tools.map(tool => tool.name).sort(), ['score', 'today', 'trend', 'week']);
  const first = await readonly.callTool({ name: 'today', arguments: { date } });
  assert.equal(first.isError, undefined);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  assert.equal((await readonly.callTool({ name: 'today', arguments: { date: '2020-01-01' } })).isError, true);

  const writable = await connect(true);
  const task = initial.data.tasks[0].id;
  const requestId = uid();
  const args = { date, requestId, change: { action: 'progress', task, result: { units: 1 } } };
  const firstProposal = await writable.callTool({ name: 'propose', arguments: args });
  assert.equal(firstProposal.isError, undefined);
  assert.deepEqual(firstProposal, await writable.callTool({ name: 'propose', arguments: args }));
  assert.equal((await store.current('day', date))?.data.tasks[0].result, undefined);
  await decide(store, requestId, true);
  assert.equal((await store.current('day', date))?.data.tasks[0].result?.units, 1);
  assert.equal((await store.current('proposal', requestId))?.data.status, 'applied');

  const delivery = await writable.callTool({ name: 'claim_reminder' });
  assert.match(JSON.stringify(delivery), /测试提醒/);
  await writable.close();
  const restarted = await connect(true);
  const repeat = await restarted.callTool({ name: 'claim_reminder' });
  assert.match(JSON.stringify(repeat), /reminder\\":null/);
});
