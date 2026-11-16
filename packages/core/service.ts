import { Daily, Request, uid, request } from './model';
import { applyRequest, newDay, newWeek } from './planning';
import { history } from './reports';
import { lifeDate, monday, shift } from './time';
import { Revision, Store } from './store';

export async function prepare(store: Store, date: string) {
  const exists = await store.current('day', date);
  if (exists) return exists;
  const [week, rubric, past] = await Promise.all([
    store.current('week', monday(date)), store.current('rubric', 'active'),
    history(store, shift(date, -28), shift(date, -1))
  ]);
  await store.save('day', date, newDay(date, week?.data ?? newWeek(date), rubric?.data, past.days), []);
  return (await store.current('day', date))!;
}

export async function suggest(store: Store, date: string, raw: Request, requestId: string = uid()) {
  const data = request.parse(raw);
  const prior = await store.current('proposal', requestId);
  if (prior) {
    if (prior.data.date !== date || JSON.stringify(prior.data.request) !== JSON.stringify(data)) throw Error('请求 ID 已用于其他提案');
    return { id: requestId, status: prior.data.status };
  }
  const current = await store.current('day', date);
  if (!current) throw Error('请先在 Obsidian 生成当天计划');
  applyRequest(current.data, data);
  await store.save('proposal', requestId, { date, base: current.id, request: data, status: 'pending' }, []);
  return { id: requestId, status: 'pending' };
}

export async function decide(store: Store, proposalId: string, accept: boolean) {
  const proposal = await store.current('proposal', proposalId);
  if (!proposal || proposal.data.status !== 'pending') throw Error('提案已处理或不存在');
  const { date, base, request } = proposal.data;
  const current = await store.current('day', date);
  const alreadyApplied = current?.data.approved?.includes(proposalId);
  if (accept && !alreadyApplied) {
    if (!current || current.id !== base) throw Error('当日记录已变化，请拒绝旧提案并重新生成');
    const changed = applyRequest(current.data, request);
    await store.save('day', date, { ...changed, approved: [...(changed.approved ?? []), proposalId] }, [current.id]);
  }
  await store.save('proposal', proposalId, { ...proposal.data, status: accept || alreadyApplied ? 'applied' : 'rejected' }, [proposal.id]);
}

export async function pending(store: Store, date?: string) {
  const result: Revision<'proposal'>[] = [];
  for (const key of await store.keys('proposal')) {
    const state = await store.inspect('proposal', key);
    const proposal = state.heads[0];
    if (!state.issues.length && state.heads.length === 1 && proposal.data.status === 'pending' && (!date || proposal.data.date === date))
      result.push(proposal);
  }
  return result;
}

export function dueReminders(day: Daily, now: Date, seen: string[]) {
  return day.reminders.filter(r => r.enabled && !seen.includes(r.id) && Date.parse(r.due) <= now.getTime()
    && now.getTime() - Date.parse(r.due) < 120 * 60_000).sort((a, b) => a.due.localeCompare(b.due));
}

export function validateTimes(data: Daily) {
  const b = data.behavior;
  if ([data.routine.studyAt, data.routine.leaveAt, b.wokeAt, b.roseAt, b.leftAt, b.arrivedAt].some(t => t && lifeDate(new Date(t)) !== data.date))
    throw Error('出门、抵达、起床和学习计划时间须属于所选生活日');
  if (b.arrivedAt && b.leftAt && b.arrivedAt < b.leftAt) throw Error('抵达时间不能早于出门时间');
  if (b.importantMessages && !b.arrivedAt) throw Error('请先记录抵达学习地点');
  if (b.fulfillment === 'notNeeded' && ((data.original?.routine ?? data.routine).leaveAt || (data.original?.routine ?? data.routine).obligation))
    throw Error('今天已有出门或履约计划，请记录实际结果');
  if (b.wokeAt && b.roseAt && b.roseAt < b.wokeAt) throw Error('离床时间不能早于醒来时间');
  if (b.bedtimeAt && ![data.date, shift(data.date, 1)].includes(lifeDate(new Date(b.bedtimeAt))))
    throw Error('入睡时间应属于当晚或次日凌晨');
}
