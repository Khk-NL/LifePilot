import { App, ItemView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { Store } from '../../packages/core/store';
import { lifeDate, shift } from '../../packages/core/time';
import { dueReminders } from '../../packages/core/service';
import { day, minutes, SectionKey, uid } from '../../packages/core/model';
import { DATA, ROOT, ensureFolder, vaultFiles } from './files';
import { Form, button, message } from './forms';
import { renderDay } from './today';
import { renderWeek, renderReports, renderData } from './pages';

const VIEW = 'lifepilot-dashboard';
type Tab = 'today' | 'week' | 'reports' | 'data';

type Dayline = {
  settings?: { dailyFolder?: string };
  createDailyNoteForDate?(date: string): Promise<TFile>;
  openJournalFile?(file: TFile): Promise<unknown>;
};

export default class LifePilot extends Plugin {
  store!: Store;
  preferences: { reminders?: boolean; seen?: string[]; lastNotice?: number; lastChange?: string } = {};
  private checking = false;

  async onload() {
    this.store = new Store(vaultFiles(this.app.vault.adapter));
    this.preferences = await this.loadData() ?? {};
    this.registerView(VIEW, leaf => new Dashboard(leaf, this));
    this.addRibbonIcon('compass', '打开 LifePilot', () => void this.open('today'));
    this.addCommand({ id: 'open', name: '打开今日面板', callback: () => void this.open('today') });
    this.addCommand({ id: 'weekly', name: '打开周计划', callback: () => void this.open('week') });
    this.registerObsidianProtocolHandler('lifepilot', params => {
      if (params.op === 'sleep') void this.importSleep(params.date, params.minutes);
      else void this.open('today');
    });
    const changed = (path: string) => {
      if (!path.startsWith(DATA + '/') || !path.endsWith('.md')) return;
      this.preferences.lastChange = new Date().toISOString();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW))
        if (leaf.view instanceof Dashboard) leaf.view.markChanged();
    };
    const vault = this.app.vault;
    this.registerEvent(vault.on('create', file => changed(file.path)));
    this.registerEvent(vault.on('modify', file => changed(file.path)));
    this.registerEvent(vault.on('delete', file => changed(file.path)));
    this.registerEvent(vault.on('rename', (file, oldPath) => { changed(oldPath); changed(file.path); }));
    const refresh = () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW))
        if (leaf.view instanceof Dashboard) leaf.view.refreshSystemDate();
    };
    this.registerDomEvent(window, 'focus', refresh);
    this.registerInterval(window.setInterval(() => { refresh(); void this.notifyDue(); }, 30_000));
  }

  async open(tab?: Tab, date?: string) {
    try {
      const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getLeaf(true);
      if (leaf.view.getViewType() !== VIEW) await leaf.setViewState({ type: VIEW, active: true });
      await this.app.workspace.revealLeaf(leaf);
      if (leaf.view instanceof Dashboard && tab) {
        const redraw = leaf.view.tab !== tab || leaf.view.date !== (date ?? lifeDate()) || !!date;
        leaf.view.tab = tab;
        leaf.view.selectDate(date);
        if (!redraw) return;
        await leaf.view.render();
      }
    } catch (error) { new Notice(message(error)); }
  }

  async openJournal(date: string) {
    day.parse(date);
    const path = ROOT + '/Journal';
    const name = `${path}/${date}.md`;
    const local = this.app.vault.getAbstractFileByPath(name);
    const dayline = (this.app as App & { plugins?: { getPlugin?(id: string): Dayline | undefined } }).plugins?.getPlugin?.('dayline-journal');
    const dailyFolder = dayline?.settings?.dailyFolder;
    if (dayline && typeof dailyFolder === 'string') {
      const folder = dailyFolder.replace(/^\/+|\/+$/g, '');
      const shared = this.app.vault.getFileByPath(folder ? `${folder}/${date}.md` : date + '.md');
      if (shared || (!local && dayline.createDailyNoteForDate)) {
        const file = shared ?? await dayline.createDailyNoteForDate?.(date);
        if (!(file instanceof TFile)) throw Error('Dayline Journal 未返回有效的日记文件');
        if (dayline.openJournalFile) await dayline.openJournalFile(file);
        else await this.app.workspace.getLeaf(true).openFile(file);
        return;
      }
    }
    await ensureFolder(this.app.vault.adapter, path);
    let file = local;
    if (!file) file = await this.app.vault.create(name, `---\nlife_date: "${date}"\n---\n\n# ${date} 日记\n\n## 今天做到了什么\n\n## 明天的第一步\n`);
    if (!(file instanceof TFile)) throw Error('日记路径已被占用');
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async exportFile(extension: string, content: string) {
    const folder = ROOT + '/Exports';
    await ensureFolder(this.app.vault.adapter, folder);
    const path = `${folder}/LifePilot-${lifeDate()}-${uid().slice(0, 8)}.${extension}`;
    await this.app.vault.create(path, content);
    new Notice('已导出到 ' + path);
  }

  private async importSleep(rawDate: string, rawMinutes: string) {
    try {
      const date = day.parse(rawDate);
      if (!rawMinutes?.trim()) throw Error('缺少睡眠分钟数');
      const sleep = minutes.parse(Number(rawMinutes));
      new Form(this.app, '导入睡眠时长', f => f.info(`${date} 的睡眠记录将更新为 ${sleep} 分钟。`), async () => {
        const current = await this.store.current('day', date);
        if (!current) throw Error('请先创建对应生活日');
        await this.store.save('day', date, { ...current.data, behavior: { ...current.data.behavior, sleep } }, [current.id]);
        await this.open('today', date);
      }).open();
    } catch (error) { new Notice(message(error)); }
  }

  private async notifyDue() {
    if (this.checking || !this.preferences.reminders || document.hidden) return;
    const now = new Date();
    if (now.getTime() - (this.preferences.lastNotice ?? 0) < 15 * 60_000) return;
    this.checking = true;
    try {
      const today = lifeDate(now);
      const seen = this.preferences.seen ?? [];
      for (const date of [shift(today, -1), today]) {
        const state = await this.store.inspect('day', date);
        if (state.issues.length || state.heads.length !== 1) continue;
        const due = dueReminders(state.heads[0].data, now, seen)[0];
        if (!due) continue;
        this.preferences.lastNotice = now.getTime();
        this.preferences.seen = [...seen, due.id].slice(-300);
        await this.saveData(this.preferences);
        new Notice('LifePilot · ' + due.title, 7000);
        break;
      }
    } catch (error) { console.warn('LifePilot reminder:', message(error)); }
    finally { this.checking = false; }
  }
}

export class Dashboard extends ItemView {
  learningOpen = false;
  weekSection: { section: SectionKey; subsection?: string } = { section: 'math' };
  learningSection: { section: SectionKey; subsection?: string } = { section: 'math' };
  private selectedDate?: string;
  private displayedDate?: string;
  get date() { return this.selectedDate ?? lifeDate(); }
  set date(date: string) { this.selectedDate = date; }
  selectDate(date?: string) { this.selectedDate = date; }
  tab: Tab = 'today';
  private renderVersion = 0;
  private stale?: HTMLElement;

  constructor(leaf: WorkspaceLeaf, readonly plugin: LifePilot) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return 'LifePilot'; }
  getIcon() { return 'compass'; }
  async onOpen() { await this.render(); }
  markChanged() { if (this.stale) this.stale.hidden = false; }

  refreshSystemDate() {
    if (!this.selectedDate && this.displayedDate !== this.date) this.run(() => this.render());
  }

  run(action: () => Promise<unknown>) {
    void action().catch(error => new Notice(message(error), 7000));
  }

  form(title: string, build: (form: Form) => void, save: (form: Form) => Promise<unknown>) {
    new Form(this.app, title, build, async f => {
      await save(f);
      await this.render();
    }).open();
  }

  async render() {
    const version = ++this.renderVersion;
    const date = this.displayedDate = this.date;
    const canvas = this.contentEl;
    canvas.empty();
    canvas.addClass('lp-dashboard');
    const root = canvas.createDiv({ cls: 'lp-shell' });
    const top = root.createDiv({ cls: 'lp-top' });
    const title = top.createDiv();
    title.createEl('h1', { text: 'LifePilot' });
    const dates = top.createDiv({ cls: 'lp-date-nav' });
    if (this.tab === 'today') dates.createEl('time', { text: date, attr: { datetime: date, 'aria-label': '生活日 ' + date } });
    if (this.tab === 'today') {
      button(dates, '前一天', () => { this.date = shift(date, -1); this.run(() => this.render()); }, 'chevron-left');
      if (date < lifeDate()) button(dates, '后一天', () => {
        const next = shift(date, 1);
        this.selectDate(next === lifeDate() ? undefined : next);
        this.run(() => this.render());
      }, 'chevron-right');
    }
    if (date !== lifeDate() && (this.tab === 'today' || this.tab === 'week' || this.tab === 'reports'))
      button(dates, this.tab === 'today' ? '今天' : '本周', () => { this.selectDate(); this.run(() => this.render()); }, 'calendar-days');
    const nav = root.createEl('nav', { cls: 'lp-nav', attr: { 'aria-label': 'LifePilot 模块' } });
    for (const [key, name, icon] of [['today', '每日', 'list-checks'], ['week', '周计划', 'calendar-range'], ['reports', '报告', 'chart-no-axes-column'], ['data', '数据与设置', 'settings']] as const) {
      const tab = button(nav, name, () => {
        if (this.tab !== key) this.selectDate();
        this.tab = key;
        this.run(() => this.render());
      }, icon);
      tab.setAttribute('aria-current', this.tab === key ? 'page' : 'false');
    }
    this.stale = root.createDiv({ cls: 'lp-stale' });
    this.stale.hidden = true;
    this.stale.createSpan({ text: '本地数据有变化。' });
    button(this.stale, '刷新', () => this.run(() => this.render()), 'refresh-cw');
    const content = root.createDiv({ cls: 'lp-content' });
    try {
      await { today: renderDay, week: renderWeek, reports: renderReports, data: renderData }[this.tab](this, content);
    } catch (error) {
      if (version === this.renderVersion) {
        content.empty();
        content.createEl('p', { cls: 'lp-error', text: message(error), attr: { role: 'alert' } });
        button(content, '查看数据与冲突', () => { this.tab = 'data'; this.run(() => this.render()); });
      }
    }
  }
}
