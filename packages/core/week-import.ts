import { z } from 'zod';
import { clock, goal, taskTemplate, uid, week, Week } from './model';

const payload = z.strictObject({
  version: z.literal(1),
  bedtime: clock.optional(),
  goals: z.array(goal).max(12).default([]),
  tasks: z.array(taskTemplate).max(150).default([])
});

export function importWeek(current: Week, raw: string) {
  const input = payload.parse(JSON.parse(raw.replace(/^\uFEFF/, '')));
  if (!input.goals.length && !input.tasks.length && !input.bedtime) throw Error('请提供周目标、任务或准备休息时间');
  const goals = new Map(current.goals.map(item => [item.subject + '/' + item.category, item]));
  const taskKey = (spec: Week['pool'][number]['spec']) => spec.subject + '/' + spec.reference.toLowerCase();
  const tasks = new Map(current.pool.map(item => [taskKey(item.spec), item]));
  const goalKeys = new Set<string>();
  const taskKeys = new Set<string>();
  let added = 0;
  let skipped = 0;
  for (const item of input.goals) {
    const key = item.subject + '/' + item.category;
    if (goalKeys.has(key)) throw Error('同一学科和类别只能导入一个目标：' + key);
    goalKeys.add(key);
    goals.set(key, item);
  }
  for (const spec of input.tasks) {
    if (spec.kind === 'newWords' || spec.kind === 'reviewWords') throw Error('新词和旧词由每日计划生成');
    const key = taskKey(spec);
    if (taskKeys.has(key)) throw Error('JSON 中的成果编号重复：' + key);
    taskKeys.add(key);
    if (tasks.has(key)) skipped++;
    else {
      tasks.set(key, { id: uid(), spec });
      added++;
    }
  }
  const data = week.parse({ ...current, bedtime: input.bedtime ?? current.bedtime, goals: [...goals.values()], pool: [...tasks.values()] });
  return { data, goals: input.goals, added, skipped };
}

export const weekImportPrompt = `请根据我提供的学习安排生成 LifePilot 周计划，只输出合法 JSON，不要 Markdown 围栏或注释。日期和 UUID 由 LifePilot 生成。
version 固定为 1。goals 与 tasks 可以省略或为空。bedtime 可省略，仅在周开始前设置，格式 HH:mm。
subject 只能是 math、408、english、leetcode。category 只能是 knowledge（知识）、practice（练习）、review（复习）。同学科同类别最多一个目标。
每个 goal 需要 subject、category、title、targetMinutes（1–1440 的整数，目标成果折算分钟）。
每个 task 需要 subject、category、title、kind、minutes（1–1440 的整数）、target（1–100000 的整数）、reference（学科内唯一成果编号）。
kind 只能是 course（网课，可用百分比，target=100）、exercise（题量）、training（专项）、recall（复习）、newProblem（力扣新题，target=1）。
408 任务可以加 branch，只接受 数据结构、计算机组成原理、操作系统、计算机网络。其他学科省略 branch。
同学科同类别的目标更新原目标，已有成果编号的任务跳过。示例：
{
  "version": 1,
  "goals": [
    { "subject": "408", "category": "practice", "title": "完成进程同步专题", "targetMinutes": 90 }
  ],
  "tasks": [
    { "subject": "408", "category": "practice", "title": "进程同步习题", "kind": "exercise", "minutes": 35, "target": 10, "reference": "os-sync-01", "branch": "操作系统" }
  ]
}`;
