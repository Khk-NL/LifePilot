import { branches, sectionGoal, sectionName, Sections, SectionKey, Subject, subjectNames, subjects, Template, uid } from '../../packages/core/model';
import { sectionOf, sectionTarget, subsectionOf } from '../../packages/core/reports';
import { lifeDate, monday } from '../../packages/core/time';
import { button, Form, readTemplate } from './forms';
import type { Dashboard } from './main';

export const sectionLabel = (layout: Sections, key: SectionKey) =>
  layout.names?.[key] ?? subjectNames[key as Subject] ?? layout.custom.find(item => item.id === key)?.name ?? '已归档栏目';

export function subsections(layout: Sections, parent: SectionKey): { id: string; name: string }[] {
  return [
    ...(parent === '408' ? branches.map(name => ({ id: name, name: layout.names?.[name] ?? name })) : []),
    ...layout.children.filter(item => item.parent === parent)
  ];
}

export function placementFields(
  f: Form, layout: Sections, subject: HTMLSelectElement,
  selection: { section: SectionKey; subsection?: string }, initial?: Template
) {
  const parents = f.select('section', '主栏目', [
    ['', '随计分学科'], ...layout.custom.map(item => [item.id, item.name] as const)
  ], initial ? initial.section : layout.custom.find(item => item.id === selection.section)?.id);
  if (!layout.custom.length) parents.parentElement!.hidden = true;
  const children = f.select('subsection', '子栏目', []);
  const refresh = (selected = '') => {
    const parent = parents.value || subject.value;
    const options = subsections(layout, parent);
    children.replaceChildren();
    children.createEl('option', { text: '无', attr: { value: '' } });
    for (const { id, name } of options) children.createEl('option', { text: name, attr: { value: id } });
    children.value = options.some(item => item.id === selected) ? selected : '';
    children.parentElement!.hidden = options.length === 0;
  };
  refresh(initial ? subsectionOf(initial) : selection.subsection);
  parents.addEventListener('change', () => refresh());
  subject.addEventListener('change', () => refresh(children.value));
}

export function readPlacedTemplate(f: Form, reference?: string): Template {
  return { ...readTemplate(f, reference), ...readPlacement(f) };
}

export function readPlacement(f: Form): Pick<Template, 'section' | 'subsection' | 'branch'> {
  const child = f.optional('subsection');
  const branch = branches.find(name => name === child);
  return { section: f.optional('section'), subsection: branch ? undefined : child, branch };
}

export async function loadSections(view: Dashboard) {
  const { store } = view.plugin;
  const state = await store.current('sections', 'active');
  const data: Sections = state?.data ?? { custom: [], children: [] };
  return {
    data,
    save: (next: Sections) => store.save('sections', 'active', next, state ? [state.id] : [])
  };
}

export function sectionNavigation(
  view: Dashboard, parent: HTMLElement, layout: Awaited<ReturnType<typeof loadSections>>,
  tab: 'day' | 'week', specs: Template[]
) {
  const selection = tab === 'day' ? view.learningSection : view.weekSection;
  const visible: SectionKey[] = [...new Set([...subjects, ...layout.data.custom.map(item => item.id), ...specs.map(sectionOf)])];
  if (!visible.includes(selection.section)) Object.assign(selection, { section: 'math', subsection: undefined });
  const current = selection.section;
  const nav = parent.createEl('nav', { cls: 'lp-subject-nav', attr: { 'aria-label': '学习栏目' } });
  const rerender = () => view.run(() => view.render());
  for (const key of visible) {
    const entry = button(nav, sectionLabel(layout.data, key), () => {
      Object.assign(selection, { section: key, subsection: undefined });
      rerender();
    });
    entry.setAttribute('aria-pressed', String(key === current));
  }

  const children = subsections(layout.data, current);
  for (const spec of specs.filter(spec => sectionOf(spec) === current)) {
    const key = subsectionOf(spec);
    if (key && !children.some(child => child.id === key)) children.push({ id: key, name: '已归档子栏目' });
  }
  if (selection.subsection && !children.some(item => item.id === selection.subsection)) selection.subsection = undefined;
  if (children.length) {
    const subnav = parent.createEl('nav', { cls: 'lp-subject-nav lp-subsection-nav', attr: { 'aria-label': '学习子栏目' } });
    for (const item of [{ id: '', name: '全部' }, ...children]) {
      const entry = button(subnav, item.name, () => {
        selection.subsection = item.id || undefined;
        rerender();
      });
      entry.setAttribute('aria-pressed', String(item.id === (selection.subsection ?? '')));
    }
  }

  return (spec: Template) => sectionOf(spec) === current && (!selection.subsection || subsectionOf(spec) === selection.subsection);
}

export async function renderSectionSettings(view: Dashboard, parent: HTMLElement) {
  const state = await view.plugin.store.inspect('sections', 'active');
  const card = parent.createEl('details', { cls: 'lp-card lp-disclosure lp-section-settings' });
  card.createEl('summary', { text: '学习栏目与每周目标' });
  const head = card.createDiv({ cls: 'lp-section-head' });
  if (state.issues.length || state.heads.length > 1) {
    card.createEl('p', { cls: 'lp-error', text: '请先在下方处理栏目修订冲突。' });
    return;
  }
  const revision = state.heads[0];
  const layout: Sections = revision?.data ?? { custom: [], children: [] };
  const week = monday(lifeDate());
  const main = [...subjects, ...layout.custom.map(item => item.id)].map(id => ({ id, name: sectionLabel(layout, id) }));
  card.createEl('p', { cls: 'lp-muted', text: '每周目标和分数都可留空。修改从本周起生效。' });
  const edit = (parent?: SectionKey, item?: { id: string; name: string }) => {
    const label = parent ? '子栏目' : '主栏目';
    const goal = item && sectionTarget(layout, item.id, week);
    view.form((item ? '编辑' : '新增') + label, f => {
      f.text('name', label + '名称', item?.name, true).maxLength = 48;
      f.details('每周目标与分数（选填）', () => {
        f.stepper('minutes', '每周目标分钟', goal?.minutes ?? 0, { max: 10080, jumps: [15, 60] });
        f.info('按任务的计划分钟 × 完成比例累计，含子栏目。设为 0 即不设目标。');
        f.stepper('points', '栏目满分', goal?.points ?? 0, { max: 100, jumps: [5, 10] });
        f.info('达到一半目标就得一半分，达到目标即满分。设为 0 时只看进度。栏目分独立于每日评分。');
      });
    }, async f => {
      const name = sectionName.parse(f.value('name'));
      const peers = parent ? subsections(layout, parent) : main;
      if (peers.some(peer => peer.id !== item?.id && peer.name.toLowerCase() === name.toLowerCase())) throw Error('已有同名' + label);
      const id = item?.id ?? uid();
      const from = monday(lifeDate());
      const nextGoal = sectionGoal.parse({ key: id, from, minutes: f.number('minutes'), points: f.number('points') });
      const next = { ...layout };
      if (parent && !item) next.children = [...layout.children, { id, parent, name }];
      else if (!item) next.custom = [...layout.custom, { id, name }];
      else if (layout.children.some(entry => entry.id === id))
        next.children = layout.children.map(entry => entry.id === id ? { ...entry, name } : entry);
      else if (layout.custom.some(entry => entry.id === id))
        next.custom = layout.custom.map(entry => entry.id === id ? { ...entry, name } : entry);
      else next.names = { ...layout.names, [id]: name };
      const previous = sectionTarget(layout, id, from);
      if (nextGoal.minutes !== (previous?.minutes ?? 0) || nextGoal.points !== (previous?.points ?? 0))
        next.goals = [...(layout.goals ?? []).filter(goal => goal.key !== id || goal.from !== from), nextGoal];
      await view.plugin.store.save('sections', 'active', next, revision ? [revision.id] : []);
    });
  };
  button(head, '新增主栏目', () => edit(), 'plus');
  const row = (container: HTMLElement, item: { id: string; name: string }, parent?: SectionKey) => {
    const line = container.createDiv({ cls: 'lp-row', attr: { 'data-section': item.id } });
    const title = line.createDiv();
    title.createEl('strong', { text: item.name });
    const goal = sectionTarget(layout, item.id, week);
    if (goal?.minutes) title.createDiv({ cls: 'lp-muted', text: `每周 ${goal.minutes} 分钟${goal.points ? ' · 满分 ' + goal.points : ''}` });
    button(line, '编辑', () => edit(parent, item), 'pencil').setAttribute('aria-label', '编辑' + item.name);
    if (!parent) button(line, '新增子栏目', () => edit(item.id), 'plus').setAttribute('aria-label', '为' + item.name + '新增子栏目');
    return line;
  };
  for (const item of main) {
    const group = card.createDiv({ cls: 'lp-section-group' });
    row(group, item);
    const children = subsections(layout, item.id);
    if (!children.length) continue;
    const list = group.createEl('details', { cls: 'lp-section-children' });
    list.createEl('summary', { text: `子栏目（${children.length}）` });
    for (const child of children) row(list, child, item.id);
  }
}
