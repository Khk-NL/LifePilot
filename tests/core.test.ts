import test from 'node:test';
import assert from 'node:assert/strict';
import { adjust, addTask, lock, newDay, newWeek, record, start, vocabulary } from '../packages/core/planning';
import { dailyScore, sectionProgress, weekly } from '../packages/core/reports';
import { learning, completion } from '../packages/core/scoring';
import { lifeDate, lifeInstant, monday, shift } from '../packages/core/time';
import { Store, Files } from '../packages/core/store';
import { defaultRubric, rubric, type Sections, type Template, uid } from '../packages/core/model';
import { prepare, validateTimes } from '../packages/core/service';
import { importWeek } from '../packages/core/week-import';

const date = '2026-11-11';
const makeDay = () => newDay(date, newWeek(date));
const course: Template = { title: '极限网课', subject: 'math', category: 'knowledge', kind: 'course', minutes: 40, target: 10, reference: 'M-01' };

test('栏目目标按生效周独立计算，子栏目成果进入上级目标', () => {
  const parent = uid(), child = uid();
  const week = monday(date);
  const layout: Sections = {
    custom: [{ id: parent, name: '数学专题' }], children: [{ id: child, parent, name: '极限' }],
    goals: [
      { key: parent, from: week, minutes: 40, points: 20 },
      { key: parent, from: shift(week, 7), minutes: 80, points: 10 },
      { key: child, from: week, minutes: 10, points: 5 }
    ]
  };
  const d = addTask(makeDay(), { ...course, section: parent, subsection: child });
  const recorded = record(d, d.tasks.at(-1)!.id, { units: 5, recalled: true });
  assert.deepEqual(sectionProgress(layout, week, [recorded], parent), { done: 20, target: 40, points: 10, max: 20 });
  assert.deepEqual(sectionProgress(layout, week, [recorded], parent, child), { done: 20, target: 10, points: 5, max: 5 });
  assert.equal(sectionProgress(layout, shift(week, 7), [recorded], parent)?.done, 0);
  assert.equal(sectionProgress(layout, shift(week, -7), [recorded], parent), undefined);
  assert.equal(recorded.rubric.learning, 45);
});

test('固定四科、120 新词、旧词零权重、课后回忆和工作量加权', () => {
  const d = lock(addTask(makeDay(), course, { cover: 'math' }), 0);
  assert.equal(d.tasks.length, 5);
  assert.equal(d.tasks.find(t => t.fixed === 'newWords')?.spec.target, 120);
  assert.equal(learning(d).denominator, 95);
  const withResult = record(d, d.tasks[0].id, { units: 7, recalled: false, actual: 15 });
  assert.equal(completion(withResult.tasks[0]), 0.63);
  assert.equal(learning(withResult).earned, 25.2);
  const recalled = record(withResult, d.tasks[0].id, { units: 7, recalled: true, actual: 100 });
  assert.equal(learning(recalled).earned, 28);
  assert.equal(learning(recalled).denominator, 95);
  assert.equal(completion(record(recalled, d.tasks[0].id, { units: 7, recalled: true, actual: 1 }).tasks[0]), 0.7);
});

test('任务拆分和放弃保持分母，额外成果增加周进度', () => {
  const d = lock(addTask(makeDay(), course), 40);
  const t = d.tasks.at(-1)!;
  const split = adjust(d, t.id, { type: 'split', first: { ...course, reference: 'M-A', minutes: 10, target: 3 },
    second: { ...course, reference: 'M-B', minutes: 30, target: 7 } }, '分段');
  const dropped = adjust(split, t.id, { type: 'discard' }, '没时间');
  assert.equal(learning(dropped).denominator, learning(d).denominator);
  assert.deepEqual(dropped.original, d.original);
  const extra = addTask(dropped, { ...course, reference: 'M-C' });
  const done = record(extra, extra.tasks.at(-1)!.id, { units: 10, recalled: true });
  assert.equal(learning(done).earned, 0);
  assert.equal(weekly(newWeek(date), [done], date).goals[0].done, 40);
});

test('禁止重复成果、重复选入、无效分档、提前录入未知旧词', () => {
  const d = addTask(makeDay(), { ...course, subject: 'leetcode', kind: 'newProblem', target: 1 });
  assert.throws(() => addTask(d, d.tasks.at(-1)!.spec), /相同成果/);
  assert.throws(() => record(d, d.tasks.at(-1)!.id, { units: 0.8 }), /50%/);
  assert.throws(() => record(d, d.tasks[3].id, { units: 1 }), /待复习/);
  const first = record(d, d.tasks[0].id, { units: 1, evidence: '同一成果' });
  assert.throws(() => record(first, first.tasks[1].id, { units: 1, evidence: '同一成果' }), /相同成果/);
});

test('没有锁定计划时仍可记录固定任务，开始后不能回填权重', () => {
  const planned = vocabulary(addTask(makeDay(), course), 100, 30, 20);
  const old = planned.tasks.find(t => t.fixed === 'reviewWords')!;
  const logged = record(planned, old.id, { units: 60 });
  assert.equal(completion(logged.tasks.find(t => t.id === old.id)!), 0.6);
  assert.equal(learning(logged).denominator, 80);
  assert.equal(learning(logged).earned, 12);
  assert.throws(() => lock(logged, 100), /学习已开始/);
  assert.throws(() => vocabulary(logged, 80), /最初待复习数/);
});

test('有效题量与网课成果独立计算，力扣两次 50% 不合并为独立实现', () => {
  const exercise = { ...course, title: '极限练习', reference: 'M-02', kind: 'exercise', category: 'practice' } as const;
  const d = lock(addTask(makeDay(), exercise), 0);
  const task = d.tasks.at(-1)!;
  assert.equal(completion(record(d, task.id, { units: 7 }).tasks.at(-1)!), 0.7);
  assert.throws(() => record(d, task.id, { units: 7.5 }), /整数/);
  const computing = addTask(makeDay(), { ...exercise, subject: '408' });
  assert.equal(completion(record(computing, computing.tasks.at(-1)!.id, { units: 7 }).tasks.at(-1)!), 0.7);
  const problem = { ...exercise, subject: 'leetcode', kind: 'newProblem', target: 1 } as const;
  const w = newWeek(date);
  w.pool = [{ id: task.id, spec: problem }];
  const unfinished = addTask(makeDay(), problem, { pool: task.id });
  for (const units of [0, 0.5, 1]) {
    const attempt = record(unfinished, unfinished.tasks.at(-1)!.id, { units });
    assert.equal(completion(attempt.tasks.at(-1)!), units);
  }
  const partial = record(unfinished, unfinished.tasks.at(-1)!.id, { units: 0.5 });
  assert.equal(weekly(w, [partial, { ...partial, date: '2026-11-12' }], date).pool[0].progress, 0.5);
});

test('凌晨归属和五维满分，缺失项保留为待录入', () => {
  assert.equal(lifeDate(new Date(lifeInstant(date, '00:30'))), date);
  const d = makeDay();
  const studyAt = lifeInstant(date, '08:00');
  d.routine = { studyAt, leaveAt: lifeInstant(date, '07:00') };
  let planned = lock(d, 0);
  for (const t of planned.tasks.filter(t => t.spec.target)) planned = record(planned, t.id, { units: t.spec.target });
  planned = start(planned, d.tasks[0].id, lifeInstant(date, '08:15'));
  planned.behavior = {
    bedtimeAt: lifeInstant(date, '23:45'), bedPhone: 0, wokeAt: lifeInstant(date, '06:30'),
    roseAt: lifeInstant(date, '06:40'), leftAt: lifeInstant(date, '07:00'), fulfillment: 'kept',
    arrivedAt: lifeInstant(date, '07:30'), importantMessages: true, chatBoundary: true,
    avoidedAimlessScrolling: true, journalWritten: true
  };
  planned.settledAt = lifeInstant(date, '23:30');
  assert.equal(dailyScore(planned).total, 100);
  assert.equal(dailyScore(planned).complete, true);
  assert.deepEqual(dailyScore(planned).entries.map(entry => entry.points), [16, 4, 5, 5, 5, 45, 6, 6, 3, 2, 1, 2]);
  assert.equal(dailyScore(makeDay()).entries[0].points, null);
  assert.equal(dailyScore({ ...makeDay(), tasks: [] }).learning.ratio, null);
});

function memory(map = new Map<string, string>()): Files {
  return {
    list: async dir => [...map.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1)),
    read: async path => map.get(path)!,
    publish: async (path, body) => { assert.ok(!map.has(path)); map.set(path, body); }
  };
}

test('离线并发、重复投递和显式合并，保留原分支', async () => {
  const a = new Store(memory());
  const b = new Store(memory());
  const original = makeDay();
  const parent = await a.save('day', date, original, []);
  await b.restore(await a.backup());
  const left = await a.save('day', date, { ...original, behavior: { sleep: 450 } }, [parent]);
  const right = await b.save('day', date, { ...original, behavior: { sleep: 480 } }, [parent]);
  assert.equal(await a.restore(await b.backup()), 1);
  assert.equal(await a.restore(await b.backup()), 0);
  await assert.rejects(a.current('day', date), /冲突/);
  await a.resolve('day', date, right, [left, right]);
  assert.equal((await a.current('day', date))?.data.behavior.sleep, 480);
  assert.equal((await a.inspect('day', date)).revisions.length, 4);
});

test('同一设备连续提交拒绝过期快照，晚到父修订恢复可读', async () => {
  const original = makeDay();
  const local = new Store(memory());
  const first = await local.save('day', date, original, []);
  const writes = await Promise.allSettled([
    local.save('day', date, { ...original, behavior: { sleep: 440 } }, [first]),
    local.save('day', date, { ...original, behavior: { sleep: 450 } }, [first])
  ]);
  assert.deepEqual(writes.map(w => w.status), ['fulfilled', 'rejected']);
  const sync = new Store(memory());
  const full = await local.backup();
  const files = Object.fromEntries(Object.entries(full.files).filter(([name]) => !name.includes(first)));
  await sync.restore({ schema: 1, files });
  await assert.rejects(sync.current('day', date), /缺失修订/);
  assert.equal(await sync.restore(full), 1);
  assert.equal((await sync.current('day', date))?.data.behavior.sleep, 440);
});

test('量规更新只影响新日，保存后的跨午夜目标按绝对时间复算', async () => {
  const store = new Store(memory());
  const w = { ...newWeek(date), bedtime: '00:15' };
  await store.save('week', w.monday, w, []);
  const before = await prepare(store, date);
  assert.equal(before.data.bedtimeTarget, lifeInstant(date, '00:15'));
  const version = rubric.parse({ ...defaultRubric, name: '新版', learning: 44, planning: [2, 2, 2] });
  await store.save('rubric', 'active', version, []);
  assert.equal((await prepare(store, date)).data.rubric.learning, 45);
  assert.equal((await prepare(store, '2026-11-12')).data.rubric.learning, 44);
});

test('验收样例：120 分钟中完成等效 92 分钟，学习分 34.5/45', () => {
  const exercise = { ...course, title: '数学练习', kind: 'exercise', minutes: 10 } as const;
  let d = lock(vocabulary(addTask(makeDay(), exercise, { cover: 'math' }), 300, 60, 30), 300);
  for (const [index, units] of [7, 1, 120, 150, 0].entries()) d = record(d, d.tasks[index].id, { units });
  const result = dailyScore(d);
  assert.equal(result.learning.denominator, 120);
  assert.equal(result.learning.earned, 92);
  assert.equal(result.entries.find(entry => entry.name === '学习成果')?.points, 34.5);
});

test('验收样例：网课完成与回忆四种组合', () => {
  const d = addTask(makeDay(), { ...course, target: 100 });
  const task = d.tasks.at(-1)!;
  for (const [units, recalled, expected] of [[80, true, 80], [80, false, 72], [100, false, 90], [100, true, 100]] as const) {
    const updated = record(d, task.id, { units, recalled }).tasks.at(-1)!;
    assert.equal(Math.round(completion(updated) * 100), expected);
  }
});

test('验收样例：移除未完成 408 不能把 22.5 刷成 45，临时替换保留原权重及原因', () => {
  const spec = { ...course, kind: 'exercise', minutes: 60 } as const;
  const plan = { ...makeDay(), tasks: [] };
  let d = lock(addTask(addTask(plan, spec), { ...spec, subject: '408', title: '408 练习' }), 0);
  d = record(d, d.tasks[0].id, { units: 10 });
  const learningPoints = (value: typeof d) => dailyScore(value).entries.find(entry => entry.name === '学习成果')?.points;
  assert.equal(learningPoints(d), 22.5);
  assert.throws(() => adjust(d, d.tasks[1].id, { type: 'discard' }, ''), /原因/);
  const dropped = adjust(d, d.tasks[1].id, { type: 'discard' }, '临时有事');
  assert.equal(learningPoints(dropped), 22.5);
  const replaced = adjust(d, d.tasks[1].id, { type: 'replace', spec: { ...spec, subject: '408', reference: '408-02', minutes: 10 } }, '改做同科题');
  assert.equal(replaced.tasks[1].spec.minutes, 60);
  assert.equal(learningPoints(replaced), 22.5);
  assert.equal(replaced.original?.tasks[1].spec.title, '408 练习');
  assert.match(replaced.changes[0].reason, /改做同科题/);
});

test('零权重、无外出、恢复日与抵达前消息检查不会引入额外分数', () => {
  const d = lock(makeDay(), 0);
  const zero = { ...d, tasks: d.tasks.map(t => ({ ...t, spec: { ...t.spec, minutes: 0 } })) };
  assert.deepEqual(learning(zero), { denominator: 0, earned: 0, ratio: null, pending: false });
  assert.equal(learning(d).earned, 0);
  const recovery = { ...d, behavior: { fulfillment: 'notNeeded', fitnessDay: 'recovery', importantMessages: true } } as const;
  assert.throws(() => validateTimes(recovery), /抵达/);
  const expected = dailyScore({ ...recovery, behavior: { ...recovery.behavior, importantMessages: undefined } });
  assert.equal(expected.entries.find(entry => entry.name.includes('无安排'))?.points, 0);
  assert.equal(expected.entries.find(entry => entry.name.includes('重要消息'))?.points, null);
  assert.equal(expected.total, dailyScore(d).total);
});

test('旧量规仍可解析与复算，跨周统计仅包含所属周', () => {
  const legacy = rubric.parse({ ...defaultRubric, name: '旧版', digital: [10, 5], planning: [3, 2] });
  const d = newDay(date, newWeek(date), legacy);
  d.routine = { entertainmentBudget: 30, focusWindow: '早上' };
  d.behavior = { entertainment: 20, focusKept: true, reflection: true };
  assert.equal(dailyScore(d).total, 17);
  const startOfWeek = monday(date);
  const last = shift(startOfWeek, 6);
  const next = shift(last, 1);
  assert.equal(lifeDate(new Date(lifeInstant(last, '00:30'))), last);
  assert.equal(monday(next), next);
  const withMath = (key: string) => {
    const value = newDay(key, newWeek(key));
    return record(value, value.tasks[0].id, { units: 1 });
  };
  assert.equal(weekly(newWeek(last), [withMath(last), withMath(next)], last).goals.find(g => g.subject === 'math' && g.category === 'review')?.done, 10);
});

test('轻量记录只保存选择的自评，不要求时间，也不把没有安排算成失败', () => {
  const d = makeDay();
  d.behavior.checkIn = { note: '今天出去散步了。' };
  const noteOnly = dailyScore(d);
  assert.equal(noteOnly.total, 0);
  assert.ok(noteOnly.entries.every(item => item.points === null));

  d.behavior.checkIn = {
    bedtime: 'slightlyLate', bedPhone: 'brief', gettingUp: 'prompt', fulfillment: 'notNeeded',
    studyStart: 'late', messages: true, chat: false
  };
  validateTimes(d);
  const score = dailyScore(d);
  assert.equal(score.possible, 95);
  assert.deepEqual(score.entries.slice(0, 9).map(item => item.points), [10, 2, 5, null, 3, null, 6, 0, null]);
  assert.equal(score.entries[3].applicable, false);
  assert.equal(score.complete, false);
});

test('周计划 JSON 归到选定周，更新同类目标并保留已导入任务的 ID', () => {
  const plan = newWeek(date);
  const target = { subject: 'math', category: 'knowledge', title: '函数复习', targetMinutes: 90 };
  const first = importWeek(plan, JSON.stringify({ version: 1, goals: [target], tasks: [course] }));
  assert.equal(first.data.monday, plan.monday);
  assert.equal(first.added, 1);
  const second = importWeek(first.data, JSON.stringify({ version: 1, goals: [{ ...target, targetMinutes: 120 }], tasks: [course] }));
  assert.equal(second.data.goals.length, 1);
  assert.equal(second.data.goals[0].targetMinutes, 120);
  assert.equal(second.data.pool[0].id, first.data.pool[0].id);
  assert.equal(second.skipped, 1);
  assert.throws(() => importWeek(plan, JSON.stringify({ version: 1, tasks: [course, course] })), /编号重复/);
  assert.throws(() => importWeek(plan, JSON.stringify({ version: 1, goals: [target, target] })), /只能导入一个/);
  assert.throws(() => importWeek(plan, JSON.stringify({ version: 1, monday: date, tasks: [course] })), /monday/);
});
