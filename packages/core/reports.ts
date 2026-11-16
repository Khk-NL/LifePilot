import { categories, Daily, Sections, SectionKey, subjects, Template, Week } from './model';
import { completion, score } from './scoring';
import { lifeInstant, monday } from './time';
import { Store } from './store';

export const sectionOf = (task: Template): SectionKey => task.section ?? task.subject;
export const subsectionOf = (task: Template) => task.subsection ?? (task.branch && !task.section ? task.branch : '');

export function sectionTarget(layout: Sections, key: string, week: string) {
  return layout.goals?.reduce<NonNullable<Sections['goals']>[number] | undefined>((latest, goal) =>
    goal.key === key && goal.from <= week && (!latest || goal.from > latest.from) ? goal : latest, undefined);
}

export function sectionProgress(layout: Sections, week: string, days: Daily[], parent: SectionKey, child?: string) {
  const goal = sectionTarget(layout, child ?? parent, week);
  if (!goal?.minutes) return undefined;
  const done = days.filter(day => monday(day.date) === week).flatMap(day => day.tasks)
    .filter(task => sectionOf(task.spec) === parent && (!child || subsectionOf(task.spec) === child))
    .reduce((sum, task) => sum + task.spec.minutes * completion(task), 0);
  return { done, target: goal.minutes, points: Math.min(1, done / goal.minutes) * goal.points, max: goal.points };
}

export async function history(store: Store, from: string, to: string) {
  const days: Daily[] = [];
  const unavailable: string[] = [];
  for (const date of await store.keys('day')) {
    if (date < from || date > to) continue;
    const { heads, issues } = await store.inspect('day', date);
    if (issues.length || heads.length !== 1) unavailable.push(date);
    else days.push(heads[0].data);
  }
  return { days, unavailable };
}

export function dailyScore(day: Daily) {
  return score(day, day.bedtimeTarget ?? lifeInstant(day.date, day.bedtime));
}

export function report(days: Daily[]) {
  const trend = days.map(d => {
    const value = dailyScore(d);
    return { date: d.date, score: value.total, possible: value.possible, complete: value.complete, settled: !!d.settledAt, learning: value.learning.ratio };
  });
  const closed = trend.filter(t => t.settled && t.complete && t.possible > 0);
  const average = closed.length ? closed.reduce((sum, t) => sum + 100 * t.score / t.possible, 0) / closed.length : null;
  return {
    count: days.length, average, trend, sleep: days.reduce((sum, d) => sum + (d.behavior.sleep ?? 0), 0),
    actual: days.flatMap(d => d.tasks).reduce((sum, t) => sum + (t.result?.actual ?? 0), 0),
    exercise: days.reduce((sum, d) => sum + (d.behavior.exercise ?? 0), 0),
    trainingDays: days.filter(d => d.behavior.fitnessDay === 'training').length,
    trainingDone: days.filter(d => d.behavior.fitnessDay === 'training' && d.behavior.trainingDone).length,
    recoveryDays: days.filter(d => d.behavior.fitnessDay === 'recovery').length,
    late: days.filter(d => d.behavior.checkIn?.fulfillment === undefined && d.behavior.fulfillment === 'late').length,
    restarts: days.reduce((sum, d) => sum + d.tasks.reduce((n, t) => n + Math.max(0, t.starts.length - 1), 0), 0)
  };
}

export function weekly(week: Week, days: Daily[], through: string) {
  const relevant = days.filter(d => monday(d.date) === week.monday);
  const tasks = relevant.flatMap(d => d.tasks);
  const goals = subjects.flatMap(subject => categories.map(category => {
    const goal = week.goals.find(g => g.subject === subject && g.category === category);
    const done = tasks.filter(t => t.spec.subject === subject && t.spec.category === category)
      .reduce((sum, t) => sum + t.spec.minutes * completion(t), 0);
    return { subject, category, title: goal?.title, target: goal?.targetMinutes, done };
  }));
  const pool = week.pool.map(({ id, spec }) => {
    const contributions = tasks.filter(t => t.pool === id).map(t => t.spec.target * completion(t) / spec.target);
    const progress = spec.kind === 'newProblem' ? Math.max(0, ...contributions) : Math.min(1, contributions.reduce((sum, value) => sum + value, 0));
    return { id, spec, progress };
  });
  const ratios = relevant.map(d => dailyScore(d).learning.ratio).filter((r): r is number => r !== null);
  const elapsed = Math.max(0, Math.min(7, (Date.parse(through) - Date.parse(week.monday)) / 86_400_000 + 1));
  const planMayBeLight = elapsed >= 3 && ratios.length >= 3 && ratios.reduce((a, b) => a + b, 0) / ratios.length >= 0.85
    && goals.some(g => g.target && g.done / g.target < elapsed / 7 * 0.8);
  return { goals, pool, planMayBeLight };
}
