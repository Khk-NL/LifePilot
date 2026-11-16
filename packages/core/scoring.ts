import { Daily, Task } from './model';
import { elapsed } from './time';

export function completion(task: Task): number {
  if (!task.result || task.discarded || task.spec.target === 0) return 0;
  const proportion = Math.min(1, task.result.units / task.spec.target);
  return task.spec.kind === 'course' ? proportion * (task.result.recalled ? 1 : 0.9) : proportion;
}

export function learning(day: Daily) {
  const tasks = day.tasks.filter(t => !t.extra && t.spec.target > 0 && t.spec.minutes > 0 && (day.original || t.fixed));
  const weight = (t: Task) => day.original || t.fixed === 'newWords' || t.fixed === 'reviewWords' ? t.spec.minutes : 10;
  const denominator = tasks.reduce((sum, t) => sum + weight(t), 0);
  const earned = tasks.reduce((sum, t) => sum + weight(t) * completion(t), 0);
  return { denominator, earned, ratio: denominator ? earned / denominator : null, pending: tasks.some(t => !t.discarded && !t.result) };
}

function tier(value: number, thresholds: readonly number[], points: readonly number[]) {
  const index = thresholds.findIndex(limit => value <= limit);
  return points[index === -1 ? points.length - 1 : index];
}

export function score(day: Daily, bedtimeTarget: string) {
  const { behavior: b, rubric: r, original } = day;
  const routine = original?.routine ?? day.routine;
  const first = day.tasks.flatMap(t => t.starts).sort()[0];
  const studyAt = day.routine.studyAt;
  const l = learning(day);
  const check = b.checkIn;
  const earned = (done: boolean | undefined, max: number) => done === undefined ? null : done ? max : 0;
  const digital = r.digital.length === 3 ? [
    ['数字生活管理', '就位后检查重要消息', r.digital[0], earned(check?.messages ?? (b.arrivedAt || b.importantMessages === false ? b.importantMessages : undefined), r.digital[0])],
    ['数字生活管理', '遵守聊天边界', r.digital[1], earned(check?.chat ?? b.chatBoundary, r.digital[1])],
    ['数字生活管理', '避免无目的刷手机', r.digital[2], earned(check?.scrolling ?? b.avoidedAimlessScrolling, r.digital[2])]
  ] as const : [
    ['数字生活管理', '娱乐预算', r.digital[0], b.entertainment === undefined || routine.entertainmentBudget === undefined ? null : b.entertainment <= routine.entertainmentBudget ? r.digital[0] : 0],
    ['数字生活管理', '专注时段', r.digital[1], b.focusKept === undefined || !routine.focusWindow ? null : b.focusKept ? r.digital[1] : 0]
  ] as const;
  const review = r.planning.length === 3 ? [
    ['计划与复盘', '晚间结算', r.planning[1], day.settledAt ? r.planning[1] : null],
    ['计划与复盘', '日记', r.planning[2], earned(b.journalWritten, r.planning[2])]
  ] as const : [
    ['计划与复盘', '晚间复盘', r.planning[1], earned(b.reflection, r.planning[1])]
  ] as const;
  const parts = [
    ['睡眠与作息', '准备休息', r.bedtimePoints[0], check?.bedtime
      ? r.bedtimePoints[{ onTime: 0, slightlyLate: 1, late: 2, veryLate: 3 }[check.bedtime]]
      : b.bedtimeAt ? tier(elapsed(bedtimeTarget, b.bedtimeAt), r.bedtimeDelay, r.bedtimePoints) : null],
    ['睡眠与作息', '床上娱乐', r.phonePoints[0], check?.bedPhone
      ? r.phonePoints[{ none: 0, brief: 1, long: 2 }[check.bedPhone]]
      : b.bedPhone === undefined ? null : tier(b.bedPhone, [0, r.phoneLimit], r.phonePoints)],
    ['行动与抗拖延', '起床后的状态', r.wakePoints[0], check?.gettingUp
      ? r.wakePoints[{ prompt: 0, slow: 1, stalled: 2 }[check.gettingUp]]
      : b.wokeAt && b.roseAt ? tier(elapsed(b.wokeAt, b.roseAt), r.wakeDelay, r.wakePoints) : null],
    ['行动与抗拖延', '履约', r.leavePoints[0], check?.fulfillment
      ? check.fulfillment === 'notNeeded' ? null : r.leavePoints[{ kept: 0, slightlyLate: 1, missed: 2 }[check.fulfillment]]
      : fulfillment(day)],
    ['行动与抗拖延', '学习启动', r.startPoints[0], check?.studyStart
      ? r.startPoints[{ onTime: 0, late: 1, skipped: 2 }[check.studyStart]]
      : first ? (studyAt && Math.abs(elapsed(studyAt, first)) <= r.startGrace ? r.startPoints[0] : r.startPoints[1]) : b.noStudy ? r.startPoints[2] : null],
    ['学习与成长', '学习成果', r.learning, l.ratio === null || (!original && !day.tasks.some(task => task.fixed && task.result))
      ? null : l.ratio * r.learning],
    ...digital,
    ['计划与复盘', '晨间计划', r.planning[0], original ? r.planning[0] : null],
    ...review
  ] as const;
  const entries = parts.map(([dimension, name, max, points]) => {
    const noObligation = name === '履约' && (check?.fulfillment ?? b.fulfillment) === 'notNeeded';
    return { dimension, name: noObligation ? '履约（当天无安排）' : name, max, points,
      applicable: !(noObligation && check?.fulfillment === 'notNeeded') };
  });
  const total = entries.reduce((sum, item) => sum + (item.points ?? 0), 0);
  return { total, possible: entries.reduce((sum, item) => sum + (item.applicable ? item.max : 0), 0),
    complete: !l.pending && entries.every(item => !item.applicable || item.points !== null), entries, learning: l };
}

function fulfillment(day: Daily) {
  const { behavior: b, rubric: r } = day;
  const planned = day.original?.routine ?? day.routine;
  if (b.fulfillment === 'notNeeded') return planned.leaveAt || planned.obligation ? null : 0;
  if (!b.fulfillment || (!planned.leaveAt && !planned.obligation)) return null;
  if (b.fulfillment !== 'kept') return r.leavePoints[2];
  if (!planned.leaveAt) return r.leavePoints[0];
  if (!b.leftAt) return null;
  return tier(elapsed(planned.leaveAt, b.leftAt), [0, r.leaveGrace], r.leavePoints);
}
