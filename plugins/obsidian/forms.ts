import { App, Modal, setIcon } from 'obsidian';
import { categories, kind, Subject, subjectNames, subjects, taskTemplate, Template } from '../../packages/core/model';
import { lifeInstant, localInput } from '../../packages/core/time';

export const categoryNames = { knowledge: '知识', practice: '练习', review: '复习' };
export const kindNames = { course: '网课', exercise: '习题', newWords: '英语新词', reviewWords: '英语旧词', newProblem: '力扣新题', recall: '复习', training: '专项训练' };
const options = (labels: Record<string, string>, keys = Object.keys(labels)) => keys.map(key => [key, labels[key]] as const);
export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function button(parent: HTMLElement, label: string, action: () => void, icon?: string) {
  const element = parent.createEl('button', { cls: 'lp-button' });
  element.type = 'button';
  if (icon) setIcon(element.createSpan({ cls: 'lp-icon', attr: { 'aria-hidden': 'true' } }), icon);
  element.createSpan({ text: label });
  element.addEventListener('click', action);
  return element;
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLOutputElement;

type Steps = { min?: number; max: number; step?: number; jumps?: number[]; start?: number; optional?: boolean; disabled?: boolean };

export class Form extends Modal {
  private fields = new Map<string, Field | HTMLFieldSetElement>();
  private form!: HTMLFormElement;
  private container!: HTMLElement;
  private error!: HTMLDivElement;

  constructor(app: App, private heading: string, private build: (form: Form) => void, private save: (form: Form) => Promise<void>) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    this.modalEl.addClass('lp-modal');
    this.form = this.contentEl.createEl('form', { cls: 'lp-form' });
    this.container = this.form;
    this.build(this);
    this.error = this.form.createEl('div', { cls: 'lp-error', attr: { role: 'alert' } });
    const submit = this.form.createEl('button', { text: '保存', cls: 'mod-cta lp-button' });
    submit.type = 'submit';
    this.form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      this.error.setText('');
      try {
        await this.save(this);
        this.close();
      } catch (err) {
        this.error.setText(message(err));
        submit.disabled = false;
      }
    });
  }

  info(text: string) { this.container.createEl('p', { cls: 'lp-muted lp-help', text }); }
  pre(text: string) { this.container.createEl('pre', { cls: 'lp-pre', text }); }

  details(label: string, build: () => void) {
    const section = this.container.createEl('details', { cls: 'lp-form-details' });
    section.createEl('summary', { text: label });
    const previous = this.container;
    this.container = section.createDiv({ cls: 'lp-form' });
    build();
    this.container = previous;
  }

  action(label: string, run: () => Promise<void>, icon?: string) {
    return button(this.container, label, () => {
      this.error.setText('');
      void run().catch(error => this.error.setText(message(error)));
    }, icon);
  }

  text(name: string, label: string, value?: string, required = false) {
    const row = this.row(name, label);
    const input = row.createEl('input', { type: 'text' });
    input.value = value ?? '';
    input.required = required;
    this.fields.set(name, input);
    return input;
  }

  stepper(name: string, label: string, value: number | undefined, options: Steps) {
    const { min = 0, max, step = 1, jumps = [], start = min, optional = false, disabled = false } = options;
    const row = this.group(name, label);
    const controls = row.createDiv({ cls: 'lp-stepper' });
    const output = controls.createEl('output', { cls: 'lp-stepper-value', attr: { 'aria-label': label } });
    this.fields.set(name, output);
    const arrows = controls.createDiv({ cls: 'lp-stepper-arrows' });
    let current = value ?? (optional ? undefined : start);
    const increments = [[step, '增加', 'chevron-up'], [-step, '减少', 'chevron-down']] as const;
    const buttons: { element: HTMLButtonElement; delta: number }[] = [];
    const update = () => {
      output.toggleAttribute('data-empty', current === undefined);
      output.value = current === undefined ? '未记录' : String(current);
      for (const { element, delta } of buttons) {
        element.disabled = disabled || current === undefined || (delta > 0 ? current >= max : current <= min);
        element.hidden = current === undefined;
      }
      if (clear && begin) {
        begin.hidden = current !== undefined;
        clear.hidden = current === undefined;
        begin.disabled = clear.disabled = disabled;
      }
    };
    const change = (delta: number) => {
      if (current === undefined) return;
      const precision = Math.max(2, String(current).split('.')[1]?.length ?? 0);
      current = Math.max(min, Math.min(max, Number((current + delta).toFixed(precision))));
      update();
    };
    for (const [delta, action, icon] of increments) {
      const element = button(arrows, '', () => change(delta), icon);
      element.setAttribute('aria-label', label + ' · ' + action + ' ' + step);
      buttons.push({ element, delta });
    }
    const shortcuts = controls.createDiv({ cls: 'lp-stepper-shortcuts' });
    for (const jump of jumps) for (const delta of [-jump, jump]) {
      const element = button(shortcuts, delta > 0 ? '+' + delta : String(delta), () => change(delta));
      element.setAttribute('aria-label', label + ' · ' + (delta > 0 ? '增加 ' : '减少 ') + jump);
      buttons.push({ element, delta });
    }
    const clear = optional ? button(shortcuts, '清空', () => { current = undefined; update(); }) : undefined;
    const begin = optional ? button(shortcuts, '记录', () => { current = start; update(); }) : undefined;
    update();
    return row;
  }

  area(name: string, label: string, value?: string) {
    const area = this.row(name, label).createEl('textarea', { attr: { rows: '4' } });
    area.value = value ?? '';
    this.fields.set(name, area);
    return area;
  }

  file(label: string, accept: string, onLoad?: (content: string) => void) {
    const input = this.row('file', label).createEl('input', { type: 'file', attr: { accept } });
    if (onLoad) input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.error.setText('');
      try {
        const content = await file.text();
        if (input.files?.[0] === file) onLoad(content);
      }
      catch (error) { this.error.setText(message(error)); }
    });
    return input;
  }

  select(name: string, label: string, choices: readonly (readonly [string, string])[], value?: string) {
    const field = this.row(name, label).createEl('select');
    for (const [key, text] of choices) field.createEl('option', { text, attr: { value: key } });
    if (value !== undefined) field.value = value;
    this.fields.set(name, field);
    return field;
  }

  time(name: string, label: string, value?: string, required = false) {
    const row = this.group(name, label).createDiv({ cls: 'lp-clock' });
    const clock = value && (value.length === 5 ? value : localInput(value).slice(11, 16));
    const hour = row.createEl('select', { attr: { 'aria-label': label + ' · 小时' } });
    const minute = row.createEl('select', { attr: { 'aria-label': label + ' · 分钟' } });
    const output = row.createEl('output', { attr: { hidden: '' } });
    hour.required = required;
    hour.createEl('option', { text: required ? '选择小时' : '未设置', attr: { value: '' } });
    for (const [field, count, unit] of [[hour, 24, '时'], [minute, 60, '分']] as const) {
      for (let n = 0; n < count; n++) {
        const key = String(n).padStart(2, '0');
        field.createEl('option', { text: key + ' ' + unit, attr: { value: key } });
      }
    }
    hour.value = clock ? clock.slice(0, 2) : '';
    minute.value = clock ? clock.slice(3) : '00';
    const update = () => {
      minute.disabled = !hour.value;
      if (minute.disabled) minute.value = '00';
      output.value = hour.value ? hour.value + ':' + minute.value : '';
    };
    hour.addEventListener('change', update);
    minute.addEventListener('change', update);
    update();
    this.fields.set(name, output);
  }

  tri(name: string, label: string, value?: boolean) {
    return this.select(name, label, [['', '待记录'], ['yes', '是'], ['no', '否']], value === undefined ? '' : value ? 'yes' : 'no');
  }

  choices(name: string, label: string, options: readonly (readonly [string, string])[], value = '') {
    const group = this.container.createEl('fieldset', { cls: 'lp-choices', attr: { 'data-field': name } });
    group.createEl('legend', { text: label });
    for (const [key, text] of options) {
      const item = group.createEl('label', { cls: 'lp-choice' });
      const control = item.createEl('input', { type: 'radio', attr: { name, value: key } });
      item.createSpan({ text });
      control.checked = key === value;
    }
    this.fields.set(name, group);
    return group;
  }

  yesNo(name: string, label: string, value?: boolean) {
    this.choices(name, label, [['', '跳过'], ['yes', '是'], ['no', '否']], value === undefined ? '' : value ? 'yes' : 'no');
  }

  value(name: string) {
    const field = this.fields.get(name)!;
    if (field.hasAttribute('data-empty')) return '';
    return 'value' in field ? field.value.trim() : field.querySelector<HTMLInputElement>('input:checked')?.value ?? '';
  }
  optional(name: string) { return this.value(name) || undefined; }
  number(name: string) { return this.value(name) ? Number(this.value(name)) : undefined; }
  iso(name: string, date: string) { return this.value(name) ? lifeInstant(date, this.value(name)) : undefined; }
  bool(name: string) { const val = this.value(name); return val ? val === 'yes' : undefined; }

  private row(name: string, label: string) {
    const row = this.container.createEl('label', { cls: 'lp-field', attr: { 'data-field': name } });
    row.createSpan({ text: label });
    return row;
  }

  private group(name: string, label: string) {
    const row = this.container.createEl('fieldset', { cls: 'lp-field lp-field-group', attr: { 'data-field': name } });
    row.createEl('legend', { text: label });
    return row;
  }
}

export function templateFields(form: Form, initial?: Template, onlySubject?: Subject, requireSubject = false) {
  form.text('title', '任务名称', initial?.title, true);
  const subject = form.select('subject', requireSubject ? '计分学科' : '学科',
    [...(requireSubject && !onlySubject ? [['', '请选择计分学科']] as const : []), ...options(subjectNames, onlySubject ? [onlySubject] : [...subjects])],
    initial?.subject ?? onlySubject);
  subject.required = true;
  subject.parentElement!.hidden = !!onlySubject;
  const taskKind = form.select('kind', '任务类型', options(kindNames, kind.options.filter(k => k !== 'newWords' && k !== 'reviewWords')), initial?.kind);
  const category = form.select('category', '周目标类别', options(categoryNames, [...categories]), initial?.category);
  form.stepper('minutes', '预计分钟', initial?.minutes ?? 25, { min: 1, max: 1440, jumps: [5, 30] });
  const targetRow = form.stepper('target', '计划成果量（题数或内容份数）', initial?.target ?? 1, { min: 1, max: 100000, jumps: [10, 100] });
  const refresh = () => {
    const newProblem = [...taskKind.options].find(option => option.value === 'newProblem')!;
    newProblem.hidden = newProblem.disabled = subject.value !== 'leetcode';
    if (newProblem.disabled && taskKind.value === 'newProblem') taskKind.value = 'exercise';
    targetRow.hidden = taskKind.value === 'newProblem';
  };
  taskKind.addEventListener('change', () => {
    category.value = taskKind.value === 'course' ? 'knowledge' : taskKind.value === 'recall' ? 'review' : 'practice';
    refresh();
  });
  subject.addEventListener('change', refresh);
  refresh();
  return subject;
}

export function readTemplate(form: Form, reference?: string) {
  const title = form.value('title'), subject = form.value('subject'), kind = form.value('kind');
  return taskTemplate.parse({
    title, subject, kind, category: form.value('category'),
    minutes: form.number('minutes'), target: kind === 'newProblem' ? 1 : form.number('target'),
    reference: reference ?? title
  });
}
