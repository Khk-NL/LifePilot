import { Notice } from 'obsidian';
import { Daily, Sections, Task, uid, subject, subjectNames, week as weekSchema } from '../../packages/core/model';
import { addTask, adjust, applyRequest, lock, record, vocabulary } from '../../packages/core/planning';
import { dailyScore, history, sectionOf, subsectionOf, weekly } from '../../packages/core/reports';
import { completion } from '../../packages/core/scoring';
import { decide, pending, prepare, validateTimes } from '../../packages/core/service';
import type { Revision } from '../../packages/core/store';
import { lifeDate, localInput, monday, shift } from '../../packages/core/time';
import { button, Form, templateFields } from './forms';
import type { Dashboard } from './main';
import { loadSections, placementFields, readPlacedTemplate, readPlacement, sectionLabel, sectionNavigation, subsections } from './sections';

export const pct = (value: number) => Math.round(100 * value) + '%';
export const num = (value: number) => Number(value.toFixed(1)).toString();

export async function renderDay(view: Dashboard, parent: HTMLElement) {
  const { store } = view.plugin;
  const date = view.date;
  const current = await store.current('day', date);
  if (!current) {
    const panel = parent.createDiv({ cls: 'lp-card' });
    panel.addClass('lp-capture');
    panel.createEl('h2', { text: '今天想记点什么？' });
    button(panel, '记一下今天', () => view.run(async () => {
      view.learningOpen = false;
      const active = await store.current('rubric', 'active');
      checkInForm(view, undefined, async update => {
        const created = await prepare(store, date);
        await store.save('day', date, update(created.data), [created.id]);
      }, active?.data.digital.length === 2);
    }), 'pen-line').addClass('mod-cta');
    button(panel, '生成当日计划', () => view.run(async () => { view.learningOpen = true; await prepare(store, date); await view.render(); }), 'plus');
    button(panel, '打开日记', () => view.run(() => view.plugin.openJournal(date)), 'book-open');
    return;
  }
  const d = current.data;
  const layout = await loadSections(view);
  const hasStarted = d.tasks.some(t => t.starts.length || t.result);
  const save = async (data: Daily) => { validateTimes(data); await store.save('day', date, data, [current.id]); };
  const result = dailyScore(d);
  const today = parent.createDiv({ cls: 'lp-card lp-capture' });
  today.createEl('h2', { text: '今天的记录' });
  if (d.behavior.checkIn?.note) today.createEl('p', { cls: 'lp-checkin-note', text: d.behavior.checkIn.note });
  if (d.behavior.sleep !== undefined) today.createDiv({ cls: 'lp-muted', text: '睡眠 ' + d.behavior.sleep + ' 分钟' });
  const actions = today.createDiv({ cls: 'lp-actions' });
  button(actions, '记一下今天', () => checkInForm(view, d, update => save(update(d))), 'pen-line').addClass('mod-cta');
  button(actions, '打开日记', () => view.run(() => view.plugin.openJournal(date)), 'book-open');
  const scoreDetails = today.createEl('details', { cls: 'lp-score' });
  scoreDetails.createEl('summary', { text: '查看今日分数' });
  scoreDetails.createEl('strong', { text: num(result.total) + ' / ' + result.possible });
  if (!result.complete) scoreDetails.createDiv({ cls: 'lp-muted', text: '暂计已记录的项目。评分说明见「数据与设置」。' });
  for (const entry of result.entries)
    scoreDetails.createDiv({ text: entry.dimension + ' · ' + entry.name + '　' + (entry.points === null ? (entry.applicable ? '未记录' : '不适用') : num(entry.points) + ' / ' + entry.max) });

  const morning = parent.createEl('details', { cls: 'lp-card lp-disclosure' });
  morning.createEl('summary', { text: '学习计划' });
  morning.open = view.learningOpen;
  morning.addEventListener('toggle', () => { if (morning.isConnected) view.learningOpen = morning.open; });
  const assigned = d.tasks.filter(t => !t.extra && (t.spec.target || t.fixed === 'reviewWords' && d.reviewBaseline === undefined && !d.original)).reduce((n, t) => n + t.spec.minutes, 0);
  morning.createDiv({ text: `学习预计 ${assigned} 分钟${d.routine.availability === undefined ? '' : ' / 可用 ' + d.routine.availability + ' 分钟'}`, cls: 'lp-muted' });
  if (d.routine.availability !== undefined && assigned > d.routine.availability) morning.createDiv({ text: '计划已超出可用时间，建议先精简主攻任务。' });
  if (d.routine.commitments) morning.createDiv({ text: d.routine.commitments });
  const morningActions = morning.createDiv({ cls: 'lp-actions' });
  button(morningActions, '从周池选择', () => view.run(() => choosePool(view, d, save, layout.data)), 'list-plus').addClass('mod-cta');
  const more = morning.createEl('details', { cls: 'lp-form-details' });
  more.createEl('summary', { text: '更多学习选项' });
  const moreActions = more.createDiv({ cls: 'lp-actions' });
  button(moreActions, '编辑学习安排', () => routineForm(view, current, save), 'calendar-clock');
  button(moreActions, d.original ? '追加额外学习' : '新增主攻', () => newTask(view, d, save, layout.data), 'plus');
  if (!d.original) {
    button(moreActions, '设置词汇量与估时', () => view.form('不背单词 · 今日基准', f => {
      f.stepper('old', '最初待复习词数', d.reviewBaseline, { max: 100000, jumps: [10, 100, 1000], disabled: d.reviewBaseline !== undefined });
      f.details('调整预计用时', () => {
        f.stepper('newMinutes', '120 新词预计分钟', d.tasks.find(t => t.fixed === 'newWords')?.spec.minutes, { min: 1, max: 1440, jumps: [5, 30] });
        f.stepper('reviewMinutes', '旧词预计分钟', d.tasks.find(t => t.fixed === 'reviewWords')?.spec.minutes, { min: 1, max: 1440, jumps: [5, 30] });
      });
    }, async f => save(vocabulary(d, f.number('old')!, f.number('newMinutes'), f.number('reviewMinutes')))), 'book-open');
    if (!hasStarted) button(morningActions, d.reviewBaseline === undefined ? '确认计划（旧词不计）' : '确认今日计划', () => view.run(async () => {
      await save(lock(d, d.reviewBaseline ?? 0));
      await view.render();
    }), 'check');
    else morning.createDiv({ text: '学习已开始。本日未锁定，只有基础任务参与日学习分。', cls: 'lp-muted' });
  } else {
    const original = morning.createEl('details');
    original.createEl('summary', { text: '原始计划与调整记录' });
    original.createDiv({ text: '锁定于 ' + localInput(d.original.at).replace('T', ' ') });
    for (const task of d.original.tasks) original.createDiv({ text: task.spec.title + ' · ' + (task.spec.target ? task.spec.minutes + ' 分钟' : '不适用') });
    for (const edit of d.changes) original.createDiv({ text: localInput(edit.at).replace('T', ' ') + ' · ' + edit.reason });
  }

  const tasks = morning.createDiv({ cls: 'lp-tasks' });
  const matches = sectionNavigation(view, tasks, layout, 'day', d.tasks.map(task => task.spec));
  const visible = d.tasks.filter(task => matches(task.spec));
  if (!visible.length) tasks.createDiv({ text: '这个栏目还没有任务。', cls: 'lp-muted' });
  for (const task of visible) renderTask(view, tasks, d, task, save, layout.data);

  const proposals = await pending(store, date);
  const reminders = parent.createEl('details', { cls: 'lp-card lp-disclosure' });
  reminders.createEl('summary', { text: proposals.length ? '提醒与小鱼提案 · ' + proposals.length + ' 条待确认' : '提醒与小鱼提案' });
  reminders.open = proposals.length > 0;
  reminders.createEl('p', { text: view.plugin.preferences.reminders ? '本设备前台提醒已启用' : '本设备前台提醒已关闭，可在设置开启。', cls: 'lp-muted' });
  button(reminders, '新增提醒', () => view.form('新增提醒', f => {
    f.select('title', '提醒内容', [['记一下今天', '记一下今天'], ['复习单词', '复习单词'], ['写日记', '写日记']]);
    f.time('at', '提醒时间', undefined, true);
  }, async f => {
    const due = f.iso('at', date)!;
    if (lifeDate(new Date(due)) !== date) throw Error('提醒时间须属于当前生活日');
    await save(applyRequest(d, { action: 'remind', reminder: { id: uid(), title: f.value('title'), due, enabled: true } }));
  }), 'bell-plus');
  for (const reminder of d.reminders) {
    const row = reminders.createDiv({ cls: 'lp-row' });
    row.createSpan({ text: localInput(reminder.due).replace('T', ' ') + ' · ' + reminder.title });
    button(row, reminder.enabled ? '关闭' : '开启', () => view.run(async () => {
      await save(applyRequest(d, { action: 'toggleReminder', reminderId: reminder.id, enabled: !reminder.enabled }));
      await view.render();
    }));
  }
  for (const proposal of proposals) {
    const section = reminders.createDiv({ cls: 'lp-proposal' });
    const request = proposal.data.request;
    section.createEl('h3', { text: { start: '启动任务', progress: '更新成果', reschedule: '调整学习时间', remind: '新增提醒', toggleReminder: '切换提醒' }[request.action] });
    if ('task' in request) section.createDiv({ text: d.tasks.find(t => t.id === request.task)?.spec.title ?? '任务已移除' });
    if (request.action === 'start') section.createDiv({ text: localInput(request.at).replace('T', ' ') });
    if (request.action === 'progress') section.createDiv({ text: `成果量 ${request.result.units} · 回忆 ${request.result.recalled ? '已完成' : '未标记'} · 实际分钟 ${request.result.actual ?? '未填写'} · 成果编号 ${request.result.evidence ?? '未填写'}` });
    if (request.action === 'reschedule') section.createDiv({ text: localInput(request.studyAt).replace('T', ' ') });
    if (request.action === 'remind') section.createDiv({ text: localInput(request.reminder.due).replace('T', ' ') + ' · ' + request.reminder.title });
    if (request.action === 'toggleReminder') section.createDiv({ text: (request.enabled ? '开启 · ' : '关闭 · ') + (d.reminders.find(r => r.id === request.reminderId)?.title ?? '提醒已移除') });
    const actions = section.createDiv({ cls: 'lp-actions' });
    for (const [label, accept] of [['接受', true], ['拒绝', false]] as const)
      button(actions, label, () => view.run(async () => { await decide(store, proposal.key, accept); await view.render(); }));
  }
}

type Save = (data: Daily) => Promise<void>;

function routineForm(view: Dashboard, current: Revision<'day'>, save: Save) {
  const d = current.data;
  const r = d.routine;
  view.form('安排可用时间', f => {
    f.stepper('availability', '今天可用于考研的分钟', r.availability, { max: 1440, jumps: [5, 30], optional: true, start: 60 });
    if (d.rubric.digital.length === 2) {
      f.stepper('budget', '娱乐预算（分钟）', r.entertainmentBudget, { max: 1440, jumps: [5, 30], optional: true, start: 30, disabled: !!d.original });
    }
  }, async f => {
    await save({
      ...d, routine: { ...r, availability: f.number('availability'),
        ...(d.rubric.digital.length === 2 ? { entertainmentBudget: f.number('budget') } : {}) }
    });
  });
}

const selfRatings = {
  bedtime: ['开始准备休息', [['onTime', '按时或晚约 15 分钟以内'], ['slightlyLate', '晚约 16–30 分钟'], ['late', '晚约 31–60 分钟'], ['veryLate', '晚了约 1 小时以上']]],
  bedPhone: ['躺下后刷手机', [['none', '没刷'], ['brief', '刷了约 10 分钟以内'], ['long', '刷了超过约 10 分钟']]],
  gettingUp: ['醒来后离床', [['prompt', '约 5 分钟内'], ['slow', '超过 5 分钟，约半小时内'], ['stalled', '超过约半小时']]],
  fulfillment: ['出门或赴约', [['kept', '按时赴约'], ['slightlyLate', '出门晚了，赴约没迟到'], ['missed', '迟到或错过'], ['notNeeded', '今天没有安排']]],
  studyStart: ['开始学习', [['onTime', '计划时间前后约 15 分钟内'], ['late', '错过计划时间，后来开始了'], ['skipped', '今天没开始']]]
} as const;

function checkInForm(view: Dashboard, day: Daily | undefined, save: (update: (data: Daily) => Daily) => Promise<void>,
  legacy = day?.rubric.digital.length === 2) {
  const b = day?.behavior;
  const check = b?.checkIn;
  view.form('记一下今天', f => {
    for (const key of Object.keys(selfRatings) as (keyof typeof selfRatings)[]) {
      const [label, choices] = selfRatings[key];
      f.choices(key, label, [['', '跳过'], ...choices], check?.[key]);
    }
    f.details('手机与聊天（选填）', () => {
      if (!legacy) {
        f.yesNo('messages', '安顿下来后处理了重要消息', check?.messages);
        f.yesNo('chat', '聊天时间符合自己的安排', check?.chat);
        f.yesNo('scrolling', '手机没有刷得比自己想要的久', check?.scrolling);
      }
    });
    f.details('运动与复盘（选填）', () => {
      f.choices('fitness', '今天的运动', [['', '跳过'], ['done', '完成训练'], ['training', '训练日，没完成'], ['pending', '训练日，未记结果'], ['recovery', '恢复日']], b?.fitnessDay === 'recovery'
        ? 'recovery' : b?.fitnessDay === 'training' ? (b.trainingDone === undefined ? 'pending' : b.trainingDone ? 'done' : 'training') : '');
      if (legacy) f.yesNo('reflection', '做了晚间复盘', b?.reflection);
      else f.yesNo('journal', '写了日记', b?.journalWritten);
      f.choices('settle', '今天记完了吗', [['', '稍后再记'], ['yes', '今天记完了']], day?.settledAt ? 'yes' : '');
    });
    f.details('睡眠时长（选填）', () => {
      f.stepper('sleep', '睡眠分钟', b?.sleep, { max: 1440, jumps: [10, 60], optional: true, start: 420 });
    });
  }, async f => save(data => {
    const fitness = f.optional('fitness');
    const ratings = {
      bedtime: f.optional('bedtime'), bedPhone: f.optional('bedPhone'), gettingUp: f.optional('gettingUp'),
      fulfillment: f.optional('fulfillment'), studyStart: f.optional('studyStart')
    } as NonNullable<Daily['behavior']['checkIn']>;
    return {
      ...data,
      settledAt: f.value('settle') === 'yes' ? data.settledAt ?? new Date().toISOString() : data.settledAt,
      behavior: {
        ...data.behavior, sleep: f.number('sleep'),
        fitnessDay: fitness === 'recovery' ? 'recovery' : fitness ? 'training' : undefined,
        trainingDone: fitness === 'done' ? true : fitness === 'training' ? false : undefined,
        ...(legacy ? { reflection: f.bool('reflection') } : { journalWritten: f.bool('journal') }),
        checkIn: { ...ratings, note: data.behavior.checkIn?.note,
          ...(legacy ? {} : { messages: f.bool('messages'), chat: f.bool('chat'), scrolling: f.bool('scrolling') }) }
      }
    };
  }));
}

function newTask(view: Dashboard, d: Daily, save: Save, layout: Sections) {
  view.form(d.original ? '额外学习' : '新增主攻任务', f => {
    const scoringSubject = subject.safeParse(view.learningSection.section).data;
    placementFields(f, layout, templateFields(f, undefined, scoringSubject, !scoringSubject), view.learningSection);
    if (!d.original) f.tri('cover', '替代本学科的基础任务', false);
  }, async f => {
    const spec = readPlacedTemplate(f);
    await save(addTask(d, spec, { cover: !d.original && f.bool('cover') ? spec.subject : undefined }));
    view.learningSection = { section: sectionOf(spec), subsection: subsectionOf(spec) || undefined };
  });
}

async function choosePool(view: Dashboard, d: Daily, save: Save, layout: Sections) {
  const key = monday(d.date);
  const current = await view.plugin.store.current('week', key);
  if (!current?.data.pool.length) throw Error('先在周计划中添加周池任务');
  const week = weekSchema.parse(current.data);
  const past = await history(view.plugin.store, key, shift(key, 6));
  const overview = weekly(week, past.days, d.date);
  const remaining = d.routine.availability === undefined ? Infinity : d.routine.availability
    - d.tasks.filter(t => !t.discarded && t.spec.target).reduce((sum, t) => sum + t.spec.minutes, 0);
  const gap = (s: Task['spec']) => {
    const g = overview.goals.find(g => g.subject === s.subject && g.category === s.category);
    return g?.target ? Math.max(0, 1 - g.done / g.target) : 0;
  };
  const match = (spec: Task['spec']) => Number(sectionOf(spec) === view.learningSection.section)
    + Number(!!view.learningSection.subsection && subsectionOf(spec) === view.learningSection.subsection);
  const items = overview.pool.filter(p => p.progress < 1 && !d.tasks.some(t => t.pool === p.id)).sort((a, b) =>
    match(b.spec) - match(a.spec)
    || Number(b.spec.minutes <= remaining) - Number(a.spec.minutes <= remaining) || gap(b.spec) - gap(a.spec) || a.progress - b.progress);
  if (!items.length) throw Error('没有可选的未完成周池任务');
  view.form('从周池选择主攻任务', f => {
    f.select('item', '周池任务', items.map(({ id, spec, progress }) => [id, `${sectionLabel(layout, sectionOf(spec))} · ${spec.title} · ${spec.minutes} 分钟 · 已完成 ${pct(progress)}`]));
    if (!d.original) f.tri('cover', '替代本学科的基础任务', false);
  }, async f => {
    const item = items.find(t => t.id === f.value('item'))!;
    await save(addTask(d, item.spec, { pool: item.id, cover: !d.original && f.bool('cover') ? item.spec.subject : undefined }));
    view.learningSection = { section: sectionOf(item.spec), subsection: subsectionOf(item.spec) || undefined };
  });
}

function renderTask(view: Dashboard, parent: HTMLElement, d: Daily, task: Task, save: Save, layout: Sections) {
  const { spec } = task;
  const card = parent.createDiv({ cls: 'lp-card lp-task' });
  card.createEl('h3', { text: spec.title });
  const status = task.discarded ? '已放弃' : task.fixed === 'reviewWords' && !d.original && d.reviewBaseline === undefined ? '待设置复习词数'
    : !spec.target ? '今日不适用' : task.result ? '已记录 ' + pct(completion(task)) : '待记录';
  card.createDiv({ text: `${spec.minutes} 分钟 · ${status}`, cls: 'lp-muted' });
  if (task.result && !task.discarded) {
    const progress = card.createEl('progress', { attr: { max: '1', 'aria-label': spec.title + '完成比例' } });
    progress.value = completion(task);
  }
  if (task.discarded) return;
  const actions = card.createDiv({ cls: 'lp-actions' });
  if (spec.target) button(actions, '记录成果', () => progressForm(view, d, task, save), 'pencil').addClass('mod-cta');
  const canAdjust = (!task.fixed || !['newWords', 'reviewWords'].includes(task.fixed)) && !task.result?.units;
  const canMove = layout.custom.length > 0 || subsections(layout, spec.subject).length > 0;
  if (canAdjust || canMove) {
    const options = card.createEl('details', { cls: 'lp-task-options' });
    options.createEl('summary', { text: '调整任务' });
    const actions = options.createDiv({ cls: 'lp-actions' });
    if (canMove) button(actions, '移动到栏目', () => view.form('移动到栏目', f => {
      const field = f.select('subject', '计分学科', [[spec.subject, subjectNames[spec.subject]]]);
      field.parentElement!.hidden = true;
      placementFields(f, layout, field, view.learningSection, spec);
    }, async f => {
      const next = { ...spec, ...readPlacement(f) };
      await save({ ...d, tasks: d.tasks.map(item => item.id === task.id ? { ...item, spec: next } : item) });
      view.learningSection = { section: sectionOf(next), subsection: subsectionOf(next) || undefined };
    }), 'folder');
    if (canAdjust && !task.result) {
      button(actions, '调整', () => view.form('替换或编辑任务', f => {
        placementFields(f, layout, templateFields(f, spec, spec.subject), view.learningSection, spec);
        if (d.original) f.info('本任务的计划权重将保持 ' + spec.minutes + ' 分钟。');
        adjustmentReason(f);
      }, async f => {
        const next = readPlacedTemplate(f, spec.title === f.value('title') ? spec.reference : undefined);
        await save(adjust(d, task.id, { type: 'replace', spec: next }, f.value('reason')));
        view.learningSection = { section: sectionOf(next), subsection: subsectionOf(next) || undefined };
      }), 'pencil');
      if (spec.minutes >= 2 && spec.target >= 2 && spec.kind !== 'newProblem')
        button(actions, '拆分', () => splitForm(view, d, task, save), 'split');
    }
    if (canAdjust && !task.fixed) button(actions, '放弃', () => view.form('放弃任务', f => {
      f.info(d.original ? '这项任务仍会计入已确认的计划。' : '调整记录会保留。');
      adjustmentReason(f);
    }, async f => save(adjust(d, task.id, { type: 'discard' }, f.value('reason')))), 'archive');
  }
}

function progressForm(view: Dashboard, d: Daily, task: Task, save: Save) {
  view.form(task.spec.title + ' · 成果', f => {
    if (task.spec.kind === 'newProblem') {
      f.choices('units', '完成标准', [['0', '未完成'], ['0.5', '理解了思路'], ['1', '能独立实现并说明']], String(task.result?.units ?? 0));
    } else {
      const progress = f.choices('progress', '完成情况', [['all', '完成'], ['none', '没做'], ['partial', '做了一部分']],
        task.result ? task.result.units === 0 ? 'none' : task.result.units === task.spec.target ? 'all' : 'partial' : 'all');
      const count = ['exercise', 'newWords', 'reviewWords'].includes(task.spec.kind);
      const units = f.stepper('units', '实际完成量 / ' + task.spec.target, task.result?.units, {
        max: Math.max(task.spec.target, task.result?.units ?? 0), step: count ? 1 : 0.1,
        jumps: task.spec.target >= 100 ? [10, 100] : count ? (task.spec.target >= 20 ? [10] : []) : [1, 10].filter(n => n < task.spec.target)
      });
      const refresh = () => { units.hidden = f.value('progress') !== 'partial'; };
      progress.addEventListener('change', refresh);
      refresh();
    }
    if (task.spec.kind === 'course') f.yesNo('recall', '完成短回忆', task.result?.recalled);
    f.details('实际用时（选填）', () => {
      f.stepper('actual', '实际分钟', task.result?.actual, { max: 1440, jumps: [5, 30], optional: true, start: task.spec.minutes });
    });
  }, async f => {
    const progress = task.spec.kind === 'newProblem' ? 'tier' : f.value('progress');
    const units = progress === 'all' ? task.spec.target : progress === 'none' ? 0 : f.number('units');
    if (units === undefined || (progress === 'partial' && !units)) throw Error('请选择实际完成量，或点「没做」');
    await save(record(d, task.id, { units, recalled: task.spec.kind === 'course' ? f.bool('recall') : undefined,
      actual: f.number('actual'), evidence: task.result?.evidence }));
  });
}

function splitForm(view: Dashboard, d: Daily, task: Task, save: Save) {
  const s = task.spec;
  view.form('拆分任务', f => {
    f.info('第二部分自动继承剩余的分钟和成果量，拆分前后总量不变。');
    f.stepper('minutes', '第一部分分钟', Math.floor(s.minutes / 2), { min: 1, max: s.minutes - 1, jumps: [5, 30] });
    f.stepper('target', '第一部分成果量', Math.floor(s.target / 2), { min: 1, max: s.target - 1, jumps: s.target > 20 ? [10, 100] : [] });
    adjustmentReason(f);
  }, async f => {
    const minutes = f.number('minutes')!, target = f.number('target')!;
    await save(adjust(d, task.id, { type: 'split',
      first: { ...s, title: s.title.slice(0, 296) + ' · 1', reference: s.reference.slice(0, 298) + '/1', minutes, target },
      second: { ...s, title: s.title.slice(0, 296) + ' · 2', reference: s.reference.slice(0, 298) + '/2', minutes: s.minutes - minutes, target: s.target - target }
    }, f.value('reason')));
  });
}

function adjustmentReason(form: Form) {
  form.choices('reason', '调整原因', [['临时有事', '临时有事'], ['学习顺序调整', '学习顺序调整'], ['任务量不合适', '任务量不合适'], ['其他安排', '其他安排']], '学习顺序调整');
}
