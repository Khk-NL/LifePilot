import { Daily, defaultRubric, fixedKinds, Progress, Request, Task, Template, Week, Rubric, uid, progress, taskTemplate, instant } from './model';
import { completion } from './scoring';
import { lifeDate, lifeInstant, monday } from './time';

export function newWeek(date: string): Week {
  return { monday: monday(date), bedtime: '23:30', goals: [], pool: [] };
}

function makeTask(spec: Template, more: Partial<Task> = {}): Task {
  return { id: uid(), spec: taskTemplate.parse(spec), starts: [], ...more };
}

export function newDay(date: string, week: Week, rubric: Rubric = defaultRubric, history: Daily[] = []): Daily {
  function estimate(kind: 'newWords' | 'reviewWords', fallback: number) {
    const samples = history.filter(d => d.date < date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14)
      .flatMap(d => d.tasks.filter(t => t.fixed === kind && t.result?.actual && completion(t) === 1).map(t => t.result!.actual!));
    return samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : fallback;
  }
  const specs: Template[] = [
    { title: '数学保温', subject: 'math', kind: 'recall', category: 'review', minutes: 10, target: 1, reference: '数学保温' },
    { title: '408 保温', subject: '408', kind: 'recall', category: 'review', minutes: 10, target: 1, reference: '408 保温' },
    { title: '英语新词', subject: 'english', kind: 'newWords', category: 'knowledge', minutes: estimate('newWords', 35), target: 120, reference: '每日新词' },
    { title: '英语旧词', subject: 'english', kind: 'reviewWords', category: 'review', minutes: estimate('reviewWords', 20), target: 0, reference: '每日旧词' },
    { title: '力扣旧题保温', subject: 'leetcode', kind: 'recall', category: 'review', minutes: 10, target: 1, reference: '力扣旧题保温' }
  ];
  return { date, bedtime: week.bedtime, bedtimeTarget: lifeInstant(date, week.bedtime), rubric, routine: {}, behavior: {}, tasks: specs.map((spec, i) => makeTask(spec, { fixed: fixedKinds[i] })), changes: [], reminders: [] };
}

export function ensureUnique(tasks: Task[]) {
  const keys = new Set<string>();
  const evidence = new Set<string>();
  for (const t of tasks) {
    const key = `${t.spec.subject}/${t.spec.reference.toLowerCase()}`;
    if (keys.has(key)) throw Error('同一学科已有相同成果编号');
    keys.add(key);
    if (!t.result?.evidence) continue;
    const reference = t.result.evidence.toLowerCase();
    if (evidence.has(reference)) throw Error('相同成果记录已用于其他任务');
    evidence.add(reference);
  }
}

export function addTask(day: Daily, spec: Template, options: { pool?: string; cover?: string } = {}): Daily {
  if (['newWords', 'reviewWords'].includes(spec.kind)) throw Error('词汇请使用当天固定任务');
  if (day.original && options.cover) throw Error('锁定后请通过替换调整原任务');
  if (options.pool && day.tasks.some(t => t.pool === options.pool)) throw Error('今天已选入该周任务');
  const covered = day.tasks.find(t => t.fixed === options.cover && options.cover === spec.subject);
  if (options.cover && (!covered || covered.spec.kind !== 'recall' || covered.result || covered.starts.length))
    throw Error('只能覆盖尚未开始的同科保温任务');
  const tasks = covered
    ? day.tasks.map(t => t.id === covered.id ? { ...t, spec: taskTemplate.parse(spec), pool: options.pool } : t)
    : [...day.tasks, makeTask(spec, { pool: options.pool, extra: !!day.original })];
  ensureUnique(tasks);
  return { ...day, tasks };
}

export function vocabulary(day: Daily, oldWords: number, newMinutes?: number, reviewMinutes?: number): Daily {
  if (day.original) throw Error('晨间计划已锁定');
  if (!Number.isInteger(oldWords) || oldWords < 0 || oldWords > 100000) throw Error('请输入当日最初待复习数');
  if (day.reviewBaseline !== undefined && day.reviewBaseline !== oldWords) throw Error('已记录最初待复习数');
  const tasks = day.tasks.map(t => {
    const estimate = t.fixed === 'newWords' ? newMinutes : t.fixed === 'reviewWords' ? reviewMinutes : undefined;
    if (t.result && estimate !== undefined && estimate !== t.spec.minutes) throw Error('已录成果的词汇任务保留原估时');
    if (t.fixed === 'reviewWords') return { ...t, spec: taskTemplate.parse({ ...t.spec, target: oldWords, minutes: reviewMinutes ?? t.spec.minutes }) };
    if (t.fixed === 'newWords') return { ...t, spec: taskTemplate.parse({ ...t.spec, minutes: newMinutes ?? t.spec.minutes }) };
    return t;
  });
  return { ...day, reviewBaseline: oldWords, tasks };
}

export function lock(day: Daily, oldWords: number, now = new Date()): Daily {
  if (day.original) throw Error('晨间计划已锁定');
  if (day.tasks.some(t => t.result || t.starts.length)) throw Error('学习已开始。可以继续记录成果，本日保留未锁定状态');
  const prepared = vocabulary(day, oldWords);
  const { tasks } = prepared;
  ensureUnique(tasks);
  return { ...prepared, original: { at: now.toISOString(), tasks, routine: day.routine } };
}

export function getTask(day: Daily, taskId: string): Task {
  const found = day.tasks.find(t => t.id === taskId);
  if (!found || found.discarded) throw Error('任务不存在或已放弃');
  return found;
}

export function record(day: Daily, taskId: string, data: Progress): Daily {
  const current = getTask(day, taskId);
  if (current.fixed === 'reviewWords' && !day.original && day.reviewBaseline === undefined) throw Error('先记录当天待复习词数');
  const result = progress.parse(data);
  if (!current.spec.target) throw Error('此任务今天不适用');
  if (current.spec.kind === 'newProblem' && ![0, 0.5, 1].includes(result.units)) throw Error('新题只支持 0%、50%、100%');
  if (['exercise', 'newWords', 'reviewWords'].includes(current.spec.kind) && !Number.isInteger(result.units))
    throw Error('有效题数或词数必须是整数');
  const tasks = day.tasks.map(t => t.id === taskId ? { ...t, result } : t);
  ensureUnique(tasks);
  return { ...day, tasks };
}

export function start(day: Daily, taskId: string, at: string): Daily {
  getTask(day, taskId);
  if (lifeDate(new Date(instant.parse(at))) !== day.date) throw Error('启动时间须属于所选生活日');
  return {
    ...day, behavior: { ...day.behavior, noStudy: false },
    tasks: day.tasks.map(t => t.id === taskId && !t.starts.includes(at) ? { ...t, starts: [...t.starts, at] } : t)
  };
}

export function adjust(day: Daily, taskId: string, edit: { type: 'discard' } | { type: 'replace'; spec: Template }
  | { type: 'split'; first: Template; second: Template }, reason: string): Daily {
  const current = getTask(day, taskId);
  if (!reason.trim()) throw Error('请输入调整原因');
  if (current.fixed === 'newWords' || current.fixed === 'reviewWords') throw Error('固定词汇任务不可移除或替换');
  if (current.result && edit.type !== 'discard') throw Error('已有成果的任务可保留成果并新增任务');
  let next: Task[];
  if (edit.type === 'discard') {
    if (current.fixed) throw Error('请将未完成的固定任务记为零成果');
    if (current.result?.units) throw Error('保留已记录成果，未完成部分仍在原分母中');
    next = day.original || current.starts.length ? [{ ...current, discarded: true }] : [];
  } else if (edit.type === 'replace') {
    if (edit.spec.subject !== current.spec.subject || edit.spec.target === 0 || ['newWords', 'reviewWords'].includes(edit.spec.kind))
      throw Error('替换必须为同科学习，且不能使用固定词汇类型');
    next = [{ ...current, pool: undefined, spec: taskTemplate.parse({ ...edit.spec, minutes: day.original ? current.spec.minutes : edit.spec.minutes }) }];
  } else {
    const { first, second } = edit;
    if (current.spec.kind === 'newProblem' || ![first, second].every(s => s.subject === current.spec.subject && s.kind === current.spec.kind && s.category === current.spec.category && s.target > 0)
      || first.minutes + second.minutes !== current.spec.minutes || first.target + second.target !== current.spec.target)
      throw Error('拆分须保持学科、类别、总分钟及成果目标');
    next = [{ ...current, spec: taskTemplate.parse(first) }, makeTask(second, { pool: current.pool, extra: current.extra })];
  }
  const tasks = day.tasks.flatMap(t => t.id === taskId ? next : [t]);
  ensureUnique(tasks);
  return { ...day, tasks, changes: [...day.changes, { at: new Date().toISOString(), reason: `${current.spec.title} · ${edit.type} · ${reason}` }] };
}

export function applyRequest(day: Daily, request: Request): Daily {
  switch (request.action) {
    case 'start': return start(day, request.task, request.at);
    case 'progress': return record(day, request.task, request.result);
    case 'reschedule':
      if (lifeDate(new Date(request.studyAt)) !== day.date) throw Error('学习时间须属于所选生活日');
      if (day.tasks.some(t => t.starts.length)) throw Error('开始学习后不能回改计划启动时间');
      return { ...day, routine: { ...day.routine, studyAt: request.studyAt }, changes: [...day.changes, { at: new Date().toISOString(), reason: '用户接受了小鱼的学习时间调整' }] };
    case 'remind':
      if (lifeDate(new Date(request.reminder.due)) !== day.date) throw Error('提醒时间须属于所选生活日');
      return { ...day, reminders: [...day.reminders.filter(r => r.id !== request.reminder.id), request.reminder] };
    case 'toggleReminder':
      if (!day.reminders.some(r => r.id === request.reminderId)) throw Error('提醒不存在');
      return { ...day, reminders: day.reminders.map(r => r.id === request.reminderId ? { ...r, enabled: request.enabled } : r) };
  }
}
