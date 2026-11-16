import { Notice } from 'obsidian';
import { categories, defaultRubric, entities, goal, rubric, Rubric, subject, subjectNames, uid, Week } from '../../packages/core/model';
import { newWeek } from '../../packages/core/planning';
import { dailyScore, history, report, sectionProgress, weekly } from '../../packages/core/reports';
import { importWeek, weekImportPrompt } from '../../packages/core/week-import';
import { monday, localInput, shift } from '../../packages/core/time';
import { button, categoryNames, kindNames, templateFields } from './forms';
import type { Dashboard } from './main';
import { loadSections, placementFields, readPlacedTemplate, renderSectionSettings, sectionLabel, sectionNavigation, subsections } from './sections';
import { num, pct } from './today';

export async function renderWeek(view: Dashboard, parent: HTMLElement) {
  const { store } = view.plugin;
  const date = view.date;
  const key = monday(date);
  const end = shift(key, 6);
  const current = await store.current('week', key);
  const past = await history(store, key, end);
  const w = current?.data ?? newWeek(key);
  if (!current && past.days[0]) w.bedtime = past.days[0].bedtime;
  const frozen = (await store.keys('day')).some(date => date >= key && date <= end);
  const result = weekly(w, past.days, date);
  const save = async (data: Week) => {
    const nowFrozen = (await store.keys('day')).some(date => date >= key && date <= end);
    if (data.bedtime !== w.bedtime && nowFrozen) throw Error('周目标入睡时间已生效，请调整下周');
    return store.save('week', key, data, current ? [current.id] : []);
  };

  const header = parent.createDiv({ cls: 'lp-card' });
  const heading = header.createDiv({ cls: 'lp-section-head' });
  const title = heading.createDiv();
  title.createEl('h2', { text: '周计划' });
  title.createEl('p', { cls: 'lp-muted', text: key + ' 至 ' + end });
  button(heading, '导入 JSON', () => {
    view.form('导入周计划 JSON', f => {
      f.info('导入到当前页面的这一周。同类目标会更新，已有任务编号会跳过。');
      const json = f.area('json', '粘贴 AI 生成的 JSON');
      json.rows = 9;
      f.file('或选择 JSON 文件', '.json,application/json', content => { json.value = content; });
      f.details('查看规则和示例', () => {
        f.action('复制给 AI', async () => {
          await navigator.clipboard.writeText(weekImportPrompt);
          new Notice('已复制周计划生成规则');
        }, 'copy');
        f.pre(weekImportPrompt);
      });
    }, async f => {
      const imported = importWeek(w, f.value('json'));
      if (JSON.stringify(imported.data) !== JSON.stringify(w)) await save(imported.data);
      new Notice(`已导入 ${imported.goals.length} 个目标、${imported.added} 项新任务，跳过 ${imported.skipped} 项已有任务`);
    });
  }, 'upload').addClass('mod-cta');
  const navigation = header.createDiv({ cls: 'lp-actions lp-week-nav' });
  for (const [name, step] of [['上一周', -7], ['下一周', 7]] as const)
    button(navigation, name, () => { view.date = shift(date, step); view.run(() => view.render()); }, step < 0 ? 'chevron-left' : 'chevron-right');
  if (!frozen) button(navigation, '设定入睡时间', () => view.form('本周入睡目标', f => {
    f.time('bed', '计划开始准备入睡', w.bedtime, true);
  }, async f => save({ ...w, bedtime: f.value('bed') })), 'moon');
  navigation.createSpan({ cls: 'lp-muted', text: '准备休息 ' + w.bedtime });
  if (past.unavailable.length) header.createEl('p', { cls: 'lp-error', text: '报告暂不包含 ' + past.unavailable.join('、') });
  if (result.planMayBeLight) header.createEl('p', { text: '日计划完成率较高，但部分周目标进度落后。可以检查每日任务量或调整接下来的主攻。' });

  const layout = await loadSections(view);
  const matches = sectionNavigation(view, parent, layout, 'week', result.pool.map(item => item.spec));
  const selected = view.weekSection;
  const progress = sectionProgress(layout.data, key, past.days, selected.section, selected.subsection);
  if (progress) {
    const card = parent.createDiv({ cls: 'lp-card lp-section-progress' });
    const name = subsections(layout.data, selected.section).find(item => item.id === selected.subsection)?.name
      ?? sectionLabel(layout.data, selected.section);
    card.createEl('strong', { text: name + ' · 本周目标' });
    card.createDiv({ cls: 'lp-muted', text: `${num(progress.done)} / ${progress.target} 成果折算分钟` });
    if (progress.max) {
      const details = card.createEl('details', { cls: 'lp-disclosure' });
      details.createEl('summary', { text: '查看栏目得分' });
      details.createDiv({ text: `栏目得分 ${num(progress.points)} / ${progress.max}` });
    }
  }
  const s = subject.safeParse(view.weekSection.section).data;
  if (s && !view.weekSection.subsection) {
    const block = parent.createEl('details', { cls: 'lp-card lp-disclosure' });
    block.createEl('summary', { text: subjectNames[s] + '目标' });
    block.open = w.goals.some(item => item.subject === s);
    for (const c of categories) {
      const g = result.goals.find(g => g.subject === s && g.category === c)!;
      const row = block.createDiv({ cls: 'lp-row' });
      row.createSpan({ text: `${categoryNames[c]} · ${g.title ?? '未设目标'} · ${num(g.done)}${g.target ? '/' + g.target : ''} 成果折算分钟` });
      button(row, '编辑' + categoryNames[c], () => view.form(subjectNames[s] + ' · ' + categoryNames[c], f => {
        f.text('title', '本周目标', g.title ?? categoryNames[c], true);
        f.stepper('target', '计划成果折算分钟', g.target ?? 60, { min: 1, max: 1440, jumps: [10, 60] });
      }, async f => save({ ...w, goals: [...w.goals.filter(g => g.subject !== s || g.category !== c),
        goal.parse({ subject: s, category: c, title: f.value('title'), targetMinutes: f.number('target') })] })));
    }
  }
  const pool = parent.createDiv({ cls: 'lp-card' });
  const poolHead = pool.createDiv({ cls: 'lp-section-head' });
  poolHead.createEl('h2', { text: '每周任务池' });
  const edit = (item?: (typeof result.pool)[number]) => view.form(item ? '编辑周池任务' : '新增周池任务', f => {
    const field = templateFields(f, item?.spec, item?.spec.subject ?? s, !s);
    placementFields(f, layout.data, field, view.weekSection, item?.spec);
  }, async f => {
    if (item && past.days.some(d => d.tasks.some(t => t.pool === item.id))) throw Error('已选入的周任务保留原成果标准，可新增后续任务');
    const next = { id: item?.id ?? uid(), spec: readPlacedTemplate(f, item?.spec.reference) };
    if (w.pool.some(p => p.id !== next.id && p.spec.subject === next.spec.subject && p.spec.reference.toLowerCase() === next.spec.reference.toLowerCase()))
      throw Error('同科已有相同成果编号');
    await save({ ...w, pool: item ? w.pool.map(p => p.id === item.id ? next : p) : [...w.pool, next] });
  });
  button(poolHead, '新增周池任务', () => edit(), 'plus');
  if (!result.pool.some(item => matches(item.spec))) pool.createEl('p', { cls: 'lp-muted', text: '这个栏目还没有任务。' });
  for (const kind of Object.keys(kindNames) as (keyof typeof kindNames)[]) {
    const group = result.pool.filter(item => matches(item.spec) && item.spec.kind === kind);
    if (!group.length) continue;
    pool.createEl('h3', { text: kindNames[kind] });
    for (const item of group) {
      const row = pool.createDiv({ cls: 'lp-row' });
      const child = subsections(layout.data, view.weekSection.section).find(child => child.id === item.spec.subsection);
      row.createSpan({ text: [item.spec.title, child?.name ?? item.spec.branch, item.spec.minutes + ' 分钟', pct(item.progress)].filter(Boolean).join(' · ') });
      if (!past.days.some(d => d.tasks.some(t => t.pool === item.id))) {
        button(row, '编辑', () => edit(item));
        button(row, '移除', () => view.form('移除周池任务', f => f.info(item.spec.title),
          async () => save({ ...w, pool: w.pool.filter(p => p.id !== item.id) })));
      }
    }
  }
}

export async function renderReports(view: Dashboard, parent: HTMLElement) {
  const date = view.date;
  const first = monday(date);
  const month = date.slice(0, 7);
  for (const [heading, start, end] of [['周报', first, shift(first, 6)], ['月报', month + '-01', month + '-31']] as const) {
    const { days, unavailable } = await history(view.plugin.store, start, end);
    const value = report(days);
    const card = parent.createDiv({ cls: 'lp-card' });
    card.createEl('h2', { text: heading + ' · ' + (heading === '周报' ? first : month) });
    if (heading === '周报') {
      const nav = card.createDiv({ cls: 'lp-actions' });
      for (const [label, step] of [['上一周', -7], ['下一周', 7]] as const)
        button(nav, label, () => { view.date = shift(date, step); view.run(() => view.render()); }, step < 0 ? 'chevron-left' : 'chevron-right');
    }
    card.createEl('p', { cls: 'lp-muted', text: `${value.count} 个记录日` });
    card.createDiv({ text: `学习 ${value.actual} 分钟 · 睡眠 ${value.sleep} 分钟` });
    if (value.trainingDays || value.recoveryDays)
      card.createDiv({ text: `训练 ${value.trainingDone}/${value.trainingDays} 天 · 恢复日 ${value.recoveryDays} 天` });
    if (value.exercise) card.createDiv({ text: `旧记录健身 ${value.exercise} 分钟` });
    if (unavailable.length) card.createEl('p', { cls: 'lp-error', text: '报告暂不包含 ' + unavailable.join('、') });
    if (!value.trend.length) continue;
    const scores = card.createEl('details', { cls: 'lp-disclosure' });
    scores.createEl('summary', { text: '查看分数趋势' });
    if (value.average !== null) scores.createDiv({ cls: 'lp-muted', text: '完整结算日的平均分 ' + num(value.average) });
    for (const point of value.trend) {
      const row = scores.createDiv({ cls: 'lp-trend' });
      row.createSpan({ text: point.date.slice(5) });
      const bar = row.createEl('meter', { attr: { min: '0', max: String(point.possible), 'aria-label': point.date + ' 分数' } });
      bar.value = point.score;
      row.createSpan({ text: num(point.score) + ' / ' + point.possible + (point.complete && point.settled ? '' : ' · 暂计') });
      const daily = days.find(d => d.date === point.date)!;
      if (daily.settledAt) row.title = dailyScore(daily).entries.filter(e => e.points === null).map(e => e.name).join('、');
    }
    const csv = ['date,score,complete,settled,learning,possible', ...value.trend.map(t => [t.date, num(t.score), t.complete, t.settled, t.learning ?? '', t.possible].join(','))].join('\n');
    button(card, '导出趋势 CSV', () => view.run(() => view.plugin.exportFile('csv', csv)), 'download');
  }
}

export async function renderData(view: Dashboard, parent: HTMLElement) {
  const { store, preferences } = view.plugin;
  await renderSectionSettings(view, parent);
  await renderScoreSettings(view, parent);
  const header = parent.createEl('details', { cls: 'lp-card lp-disclosure' });
  header.createEl('summary', { text: '提醒、备份与同步' });
  header.createEl('p', { text: '查看跨设备同步状态，请打开 Fast Note Sync。', cls: 'lp-muted' });
  header.createDiv({ text: '本次运行最近变化 · ' + (preferences.lastChange ? localInput(preferences.lastChange).replace('T', ' ') : '暂无') });
  const actions = header.createDiv({ cls: 'lp-actions' });
  button(actions, '检查本地数据', () => view.run(() => view.render()), 'refresh-cw');
  button(actions, '导出业务备份', () => view.run(async () => view.plugin.exportFile('json', JSON.stringify(await store.backup(), null, 2))), 'download');
  button(actions, '导入业务备份', () => {
    let picker: HTMLInputElement;
    view.form('导入业务备份', f => {
      f.info('选择 LifePilot 导出的 JSON 文件。修订将追加，已存在的内容不会被覆盖。');
      picker = f.file('备份文件', '.json,application/json');
    }, async () => {
      const file = picker.files?.[0];
      if (!file) throw Error('请选择 JSON 备份文件');
      const count = await store.restore(JSON.parse(await file.text()));
      new Notice('已导入 ' + count + ' 个修订');
    });
  }, 'upload');
  button(actions, preferences.reminders ? '关闭设备提醒' : '开启设备提醒', () => view.run(async () => {
    preferences.reminders = !preferences.reminders;
    await view.plugin.saveData(preferences);
    await view.render();
  }), 'bell');

  const conflict = header.createEl('details', { cls: 'lp-disclosure' });
  const conflictLabel = conflict.createEl('summary', { text: '查看同步冲突' });
  let count = 0;
  for (const kind of Object.keys(entities) as (keyof typeof entities)[]) {
    for (const key of await store.keys(kind)) {
      const { heads, issues } = await store.inspect(kind, key);
      if (!issues.length && heads.length <= 1) continue;
      count++;
      const item = conflict.createDiv({ cls: 'lp-proposal' });
      item.createEl('h3', { text: kind + ' / ' + key });
      if (issues.length) item.createEl('p', { cls: 'lp-error', text: '等待同步或从备份恢复 · ' + issues.join('、') });
      for (const h of heads) {
        const details = item.createEl('details');
        details.createEl('summary', { text: localInput(h.at).replace('T', ' ') + ' · ' + h.id.slice(0, 8) });
        details.createEl('pre', { text: JSON.stringify(h.data, null, 2) });
        if (!issues.length && heads.length > 1)
          button(details, '采用此版本', () => view.form('确认合并冲突', f => f.info('此版本将成为新修订，两个原分支保留在历史中。'),
            async () => store.resolve(kind, key, h.id, heads.map(head => head.id))));
      }
    }
  }
  if (!count) conflict.createEl('p', { cls: 'lp-muted', text: '当前未发现冲突或缺失的父修订。' });
  else {
    conflictLabel.setText(`同步冲突（${count} 项待处理）`);
    header.open = conflict.open = true;
  }
}

async function renderScoreSettings(view: Dashboard, parent: HTMLElement) {
  const { store } = view.plugin;
  const active = await store.inspect('rubric', 'active');
  const settings = parent.createEl('details', { cls: 'lp-card lp-disclosure lp-score-settings' });
  settings.createEl('summary', { text: '每日评分怎么计算' });
  const current = active.heads[0];
  const configurable = current?.data.digital.length === 3 ? current.data : defaultRubric;
  const rule = current?.data ?? defaultRubric;
  settings.createEl('p', { cls: 'lp-muted', text: '想记哪项就记哪项。分数供回顾时参考，未记的项目会标为「未记录」。' });
  const list = settings.createEl('ul', { cls: 'lp-rule-list' });
  for (const line of scoreRules(rule)) list.createEl('li', { text: line });
  settings.createEl('p', { cls: 'lp-muted', text: '睡眠时长和运动只作记录。每周栏目分单独显示。' });
  if (active.heads.length > 1 || active.issues.length) return;
  const advanced = settings.createEl('details', { cls: 'lp-disclosure' });
  advanced.createEl('summary', { text: '自定义每日评分' });
  advanced.createEl('p', { cls: 'lp-muted', text: '各项满分合计 100。改动仅用于之后新建的记录。' });
  button(advanced, '编辑分值和分档', () => view.form('编辑每日评分', f => {
    const data = configurable;
    f.info('保存前会检查各项最高分之和为 100，且分档由高到低。');
    f.text('name', '版本名称', data.name, true);
    f.info('名称用于识别这套分值。旧记录仍按各自保存的规则计算。');
    for (const [key, title] of Object.entries(rubricLabels) as [RubricKey, string][]) {
      const value = data[key];
      const timing = /Delay|Limit|Grace/.test(key);
      const opts = timing ? { max: 1440, jumps: [5, 30] } : { max: 100, step: 0.1, jumps: [1, 5] };
      if (Array.isArray(value)) f.details(title, () => {
        if (timing) f.info('用于有时间戳的记录。每日点选使用表单里显示的档位。');
        value.forEach((part, i) => f.stepper(key + i, (rubricParts[key]?.[i] ?? '第 ' + (i + 1) + ' 档'), part, opts));
      });
      else {
        f.stepper(key, title, value, opts);
        if (timing) f.info('用于有时间戳的记录。');
        else f.info('按任务的计划分钟加权，实际用时仅供回顾。');
      }
    }
  }, async f => {
    const data: Record<string, unknown> = { name: f.value('name') };
    for (const key of Object.keys(rubricLabels) as RubricKey[]) {
      const value = configurable[key];
      data[key] = Array.isArray(value) ? value.map((_, i) => f.number(key + i)) : f.number(key);
    }
    const parsed = rubric.parse(data);
    if (parsed.digital.length !== 3) throw Error('请填写最终量规的三个数字生活与计划复盘分项');
    if (parsed.name === (current?.data ?? defaultRubric).name) throw Error('请给量规填写新的版本名称');
    await store.save('rubric', 'active', parsed, current ? [current.id] : []);
  }), 'sliders-horizontal');
}

function scoreRules(r: Rubric) {
  const [messages, chat, scrolling] = r.digital;
  const [morning, evening, journal] = r.planning;
  return [
    `睡眠 ${r.bedtimePoints[0] + r.phonePoints[0]} 分。准备休息最多 ${r.bedtimePoints[0]} 分，躺下后少刷手机最多 ${r.phonePoints[0]} 分。`,
    `行动 ${r.wakePoints[0] + r.leavePoints[0] + r.startPoints[0]} 分。起床、赴约、开始学习分别最多 ${r.wakePoints[0]}、${r.leavePoints[0]}、${r.startPoints[0]} 分。当天无安排可跳过赴约。`,
    `学习 ${r.learning} 分。按计划分钟加权。例：只安排了 20 分钟且做完一半，可得 ${num(r.learning / 2)} 分。没确认计划时只看固定任务。`,
    scrolling === undefined ? `数字生活 ${messages + chat} 分。娱乐预算 ${messages} 分，专注时段 ${chat} 分。`
      : `数字生活 ${messages + chat + scrolling} 分。重要消息 ${messages} 分，聊天边界 ${chat} 分，少刷手机 ${scrolling} 分。`,
    journal === undefined ? `计划与复盘 ${morning + evening} 分。确认计划 ${morning} 分，复盘 ${evening} 分。`
      : `计划与复盘 ${morning + evening + journal} 分。确认计划 ${morning} 分，记完当天 ${evening} 分，写日记 ${journal} 分。`
  ];
}

type RubricKey = Exclude<keyof typeof defaultRubric, 'name'>;
const rubricParts: Partial<Record<RubricKey, string[]>> = {
  bedtimePoints: ['按时或晚约 15 分钟内', '晚约 16–30 分钟', '晚约 31–60 分钟', '晚了约 1 小时以上'],
  phonePoints: ['没刷', '刷了约 10 分钟以内', '刷了超过约 10 分钟'],
  wakePoints: ['约 5 分钟内', '超过 5 分钟，约半小时内', '超过约半小时'],
  leavePoints: ['按时赴约', '出门晚了，赴约没迟到', '迟到或错过'],
  startPoints: ['计划时间前后约 15 分钟内', '错过计划时间，后来开始了', '当天没开始'],
  digital: ['重要消息', '聊天边界', '无目的刷手机'],
  planning: ['晨间计划', '晚间结算', '日记']
};
const rubricLabels: Record<RubricKey, string> = {
  bedtimeDelay: '准备入睡的 3 个延迟上限（分钟）', bedtimePoints: '准备入睡的 4 档分数',
  phoneLimit: '床上娱乐的中档时长上限', phonePoints: '床上娱乐的 3 档分数',
  wakeDelay: '起床行动的 2 个延迟上限', wakePoints: '起床行动的 3 档分数',
  leaveGrace: '出门轻微延迟上限', leavePoints: '履约的 3 档分数',
  startGrace: '学习准点启动的前后容差', startPoints: '学习启动的 3 档分数',
  learning: '学习成果最高分', digital: '重要消息、聊天边界、无目的刷手机分数', planning: '晨间计划、晚间结算、日记分数'
};
