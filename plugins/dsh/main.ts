import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdir, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { day, id, request, uid } from '../../packages/core/model';
import { dailyScore, history, report, weekly } from '../../packages/core/reports';
import { completion } from '../../packages/core/scoring';
import { dueReminders, suggest } from '../../packages/core/service';
import { Store } from '../../packages/core/store';
import { lifeDate, monday, shift } from '../../packages/core/time';
import { nodeFiles } from './files';

const args = parseArgs({
  options: { root: { type: 'string' }, proposals: { type: 'boolean' }, 'reminder-state': { type: 'string' } }
}).values;
if (!args.root) throw Error('必须指定 --root <vault>/LifePilot/Data');
const store = new Store(await nodeFiles(args.root));
const server = new McpServer({ name: 'lifepilot', version: '1.0.8' });
const onDate = (value?: string) => value ?? lifeDate();

function add<T extends z.ZodRawShape>(name: string, description: string, shape: T, readOnly: boolean,
  run: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>) {
  const schema = z.object(shape);
  server.registerTool(name, { description, inputSchema: schema as z.ZodType, annotations: { readOnlyHint: readOnly, openWorldHint: false } }, async (input: unknown) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await run(schema.parse(input) as z.infer<z.ZodObject<T>>)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '未知 LifePilot 错误' }] };
    }
  });
}

async function today(value?: string) {
  const date = onDate(value);
  const current = await store.current('day', date);
  if (!current) throw Error('该生活日尚未生成，请在 Obsidian 生成');
  return current.data;
}

add('today', '读取 LifePilot 计划、任务、提醒 ID 和成果比例。不包含日记、课表备注或成果原文。', { date: day.optional() }, true, async ({ date }) => {
  const data = await today(date);
  return {
    date: data.date, plannedStart: data.routine.studyAt, availableMinutes: data.routine.availability, locked: !!data.original,
    tasks: data.tasks.map(t => ({ id: t.id, title: t.spec.title, subject: t.spec.subject, kind: t.spec.kind, minutes: t.spec.minutes,
      target: t.spec.target, completed: t.result?.units, completion: t.result ? completion(t) : null, starts: t.starts, discarded: !!t.discarded, extra: !!t.extra })),
    reminders: data.reminders.map(r => ({ id: r.id, due: r.due, enabled: r.enabled }))
  };
});

add('score', '读取确定性评分和待录状态。', { date: day.optional() }, true, async ({ date }) => {
  const data = await today(date);
  return { date: data.date, rubric: data.rubric.name, settled: !!data.settledAt, ...dailyScore(data) };
});

add('week', '读取对应周的四科目标、周池进度和负载提示。', { date: day.optional() }, true, async ({ date }) => {
  const value = onDate(date);
  const key = monday(value);
  const current = await store.current('week', key);
  if (!current) throw Error('该周尚未设置目标');
  const { days, unavailable } = await history(store, key, shift(key, 6));
  return { week: key, unavailable, ...weekly(current.data, days, value) };
});

add('trend', '查询截至指定生活日的聚合统计、学习趋势和结算摘要。', {
  date: day.optional(), days: z.int().min(1).max(90).default(7)
}, true, async ({ date, days }) => {
  const end = onDate(date);
  const from = shift(end, 1 - days);
  const values = await history(store, from, end);
  return { from, end, unavailable: values.unavailable, ...report(values.days) };
});

if (args.proposals) add('propose', '仅在用户明确要求时提交提案。启动、成果、调整与提醒均需在 Obsidian 逐项批准。重试应复用请求 UUID。', {
  date: day.optional(), change: request, requestId: id.optional()
}, false, async ({ date, change, requestId }) => suggest(store, onDate(date), change, requestId ?? uid()));

if (args['reminder-state']) {
  const folder = args['reminder-state'];
  if (!isAbsolute(folder)) throw Error('--reminder-state 必须是一个独立的绝对路径');
  await mkdir(folder, { recursive: true });
  async function claim(name: string) {
    try {
      const handle = await open(join(folder, name), 'wx');
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
  add('claim_reminder', '供用户创建的 DSH Schedule 专用。仅当返回提醒时向当前私有会话发一条提醒；空结果保持安静。', {}, false, async () => {
    const now = new Date();
    const names = await readdir(folder);
    const seen = names.filter(n => n.startsWith('sent-')).map(n => n.slice(5));
    const bucket = Math.floor(now.getTime() / (15 * 60_000));
    if (names.includes('slot-' + (bucket - 1))) return { reminder: null };
    const dates = [shift(lifeDate(now), -1), lifeDate(now)];
    for (const date of dates) {
      const state = await store.inspect('day', date);
      if (state.issues.length || state.heads.length > 1) throw Error('提醒来源存在冲突，待修复后再运行');
      const reminder = state.heads[0] && dueReminders(state.heads[0].data, now, seen)[0];
      if (!reminder) continue;
      if (!await claim('slot-' + bucket) || !await claim('sent-' + reminder.id)) break;
      return { reminder: { id: reminder.id, title: reminder.title, due: reminder.due } };
    }
    return { reminder: null };
  });
}

await server.connect(new StdioServerTransport());
