import { z } from 'zod';

export const subjects = ['math', '408', 'english', 'leetcode'] as const;
export const subject = z.enum(subjects);
export const subjectNames = { math: '考研数学', '408': '408', english: '考研英语', leetcode: 'LeetCode' };
export const categories = ['knowledge', 'practice', 'review'] as const;
export const category = z.enum(categories);
export const kind = z.enum(['course', 'exercise', 'newWords', 'reviewWords', 'newProblem', 'recall', 'training']);
export const id = z.uuid();
export const day = z.iso.date();
export const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const instant = z.iso.datetime();
export const text = z.string().trim().min(1).max(300);
export const sectionName = z.string().trim().min(1).max(48);
export const sectionKey = z.union([subject, id]);
export const branches = ['数据结构', '计算机组成原理', '操作系统', '计算机网络'] as const;
export const sectionGoal = z.strictObject({
  key: z.union([sectionKey, z.enum(branches)]), from: day,
  minutes: z.int().min(0).max(10080), points: z.int().min(0).max(100)
}).refine(goal => goal.minutes > 0 || goal.points === 0, '设置分值前，请先设置每周目标');
export const sections = z.strictObject({
  custom: z.array(z.strictObject({ id, name: sectionName })).max(100),
  children: z.array(z.strictObject({ id, parent: sectionKey, name: sectionName })).max(300),
  names: z.record(z.string(), sectionName).optional(),
  goals: z.array(sectionGoal).optional()
}).superRefine(({ custom, children }, ctx) => {
  const parents = new Set<string>([...subjects, ...custom.map(item => item.id)]);
  const ids = [...custom, ...children].map(item => item.id);
  if (new Set(ids).size !== ids.length || children.some(item => !parents.has(item.parent)))
    ctx.addIssue({ code: 'custom', message: '学习板块编号重复或缺少上级板块' });
});
const note = z.string().trim().max(3000);
export const minutes = z.int().min(0).max(1440);
const duration = minutes.min(1);
const quantity = z.int().min(0).max(100000);
export const progress = z.strictObject({
  units: z.number().min(0).max(100000),
  recalled: z.boolean().optional(),
  actual: minutes.optional(),
  evidence: text.optional()
});

export const taskTemplate = z.strictObject({
  title: text, subject, kind, category, minutes: duration, target: quantity,
  reference: text, branch: z.enum(branches).optional(),
  section: id.optional(), subsection: id.optional()
}).superRefine((task, ctx) => {
  const requiredSubject = { newWords: 'english', reviewWords: 'english', newProblem: 'leetcode' } as Record<string, string>;
  if ((requiredSubject[task.kind] && task.subject !== requiredSubject[task.kind]) || (task.branch && task.subject !== '408'))
    ctx.addIssue({ code: 'custom', message: '学科与任务类型或 408 分科不匹配' });
  if ((!task.target && task.kind !== 'reviewWords') || (task.kind === 'newProblem' && task.target !== 1))
    ctx.addIssue({ code: 'custom', message: '任务成果目标无效' });
});

export const fixedKinds = ['math', '408', 'newWords', 'reviewWords', 'leetcode'] as const;
export const task = z.strictObject({
  id, spec: taskTemplate, fixed: z.enum(fixedKinds).optional(), pool: id.optional(),
  extra: z.boolean().optional(), discarded: z.boolean().optional(), result: progress.optional(),
  starts: z.array(instant).max(200)
});
export const goal = z.strictObject({
  subject, category, title: text, targetMinutes: duration
});
export const week = z.strictObject({
  monday: day, bedtime: clock, goals: z.array(goal).max(12),
  pool: z.array(z.strictObject({ id, spec: taskTemplate })).max(150)
});

const scorePart = z.number().min(0).max(100);
const threshold3 = z.tuple([minutes, minutes, minutes]).refine(values => values[0] < values[1] && values[1] < values[2]);
const threshold2 = z.tuple([minutes, minutes]).refine(values => values[0] < values[1]);
export const rubric = z.strictObject({
  name: text, bedtimeDelay: threshold3, bedtimePoints: z.tuple([scorePart, scorePart, scorePart, scorePart]),
  phoneLimit: minutes, phonePoints: z.tuple([scorePart, scorePart, scorePart]),
  wakeDelay: threshold2, wakePoints: z.tuple([scorePart, scorePart, scorePart]),
  leaveGrace: minutes, leavePoints: z.tuple([scorePart, scorePart, scorePart]),
  startGrace: minutes, startPoints: z.tuple([scorePart, scorePart, scorePart]),
  learning: scorePart,
  digital: z.union([z.tuple([scorePart, scorePart, scorePart]), z.tuple([scorePart, scorePart])]),
  planning: z.union([z.tuple([scorePart, scorePart, scorePart]), z.tuple([scorePart, scorePart])])
}).superRefine((r, ctx) => {
  const groups = [r.bedtimePoints, r.phonePoints, r.wakePoints, r.leavePoints, r.startPoints];
  const maximum = groups.reduce((sum, points) => sum + points[0], r.learning) + [...r.digital, ...r.planning].reduce((sum, points) => sum + points, 0);
  if (maximum !== 100 || groups.some(points => points.some((v, i) => i > 0 && v > points[i - 1])))
    ctx.addIssue({ code: 'custom', message: '量规满分必须是 100，分档不得递增' });
  if (r.digital.length !== r.planning.length)
    ctx.addIssue({ code: 'custom', message: '数字生活与计划复盘必须使用同一版本的计分结构' });
});
export const defaultRubric: Rubric = {
  name: 'LifePilot 1.0 最终量规', bedtimeDelay: [15, 30, 60], bedtimePoints: [16, 10, 5, 0],
  phoneLimit: 10, phonePoints: [4, 2, 0], wakeDelay: [10, 30], wakePoints: [5, 3, 0],
  leaveGrace: 10, leavePoints: [5, 3, 0], startGrace: 15, startPoints: [5, 3, 0],
  learning: 45, digital: [6, 6, 3], planning: [2, 1, 2]
};

const routine = z.strictObject({
  availability: minutes.optional(), commitments: note.optional(),
  studyAt: instant.optional(), leaveAt: instant.optional(), obligation: text.optional(),
  entertainmentBudget: minutes.optional(), focusWindow: text.optional()
});
const behavior = z.strictObject({
  bedtimeAt: instant.optional(), bedPhone: minutes.optional(), sleep: minutes.optional(),
  wokeAt: instant.optional(), roseAt: instant.optional(), leftAt: instant.optional(),
  fulfillment: z.enum(['kept', 'late', 'missed', 'notNeeded']).optional(),
  noStudy: z.boolean().optional(), entertainment: minutes.optional(), focusKept: z.boolean().optional(),
  exercise: minutes.optional(), reflection: z.boolean().optional(),
  arrivedAt: instant.optional(), importantMessages: z.boolean().optional(), chatBoundary: z.boolean().optional(),
  avoidedAimlessScrolling: z.boolean().optional(), journalWritten: z.boolean().optional(),
  fitnessDay: z.enum(['training', 'recovery']).optional(), trainingDone: z.boolean().optional(),
  checkIn: z.strictObject({
    bedtime: z.enum(['onTime', 'slightlyLate', 'late', 'veryLate']).optional(),
    bedPhone: z.enum(['none', 'brief', 'long']).optional(),
    gettingUp: z.enum(['prompt', 'slow', 'stalled']).optional(),
    fulfillment: z.enum(['kept', 'slightlyLate', 'missed', 'notNeeded']).optional(),
    studyStart: z.enum(['onTime', 'late', 'skipped']).optional(),
    messages: z.boolean().optional(), chat: z.boolean().optional(), scrolling: z.boolean().optional(),
    note: note.optional()
  }).optional()
});
export const reminder = z.strictObject({ id, title: text, due: instant, enabled: z.boolean() });
const change = z.strictObject({ at: instant, reason: text });
export const daily = z.strictObject({
  date: day, bedtime: clock, bedtimeTarget: instant.optional(), rubric, routine, behavior, tasks: z.array(task).max(150),
  reviewBaseline: quantity.optional(),
  original: z.strictObject({ at: instant, tasks: z.array(task).max(150), routine }).optional(),
  changes: z.array(change).max(500), settledAt: instant.optional(),
  reminders: z.array(reminder).max(20), approved: z.array(id).max(500).optional()
});
export const request = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), task: id, at: instant }),
  z.strictObject({ action: z.literal('progress'), task: id, result: progress }),
  z.strictObject({ action: z.literal('reschedule'), studyAt: instant }),
  z.strictObject({ action: z.literal('remind'), reminder }),
  z.strictObject({ action: z.literal('toggleReminder'), reminderId: id, enabled: z.boolean() })
]);
export const proposal = z.strictObject({
  date: day, base: id, request, status: z.enum(['pending', 'applied', 'rejected'])
});

export const entities = { day: daily, week, rubric, proposal, sections };
export type Sections = z.infer<typeof sections>;
export type SectionKey = z.infer<typeof sectionKey>;
export type Task = z.infer<typeof task>;
export type Template = z.infer<typeof taskTemplate>;
export type Week = z.infer<typeof week>;
export type Daily = z.infer<typeof daily>;
export type Rubric = z.infer<typeof rubric>;
export type Request = z.infer<typeof request>;
export type Proposal = z.infer<typeof proposal>;
export type Progress = z.infer<typeof progress>;
export type Subject = z.infer<typeof subject>;
export type Category = z.infer<typeof category>;
export type Kind = z.infer<typeof kind>;
export type Reminder = z.infer<typeof reminder>;

export function uid() {
  return globalThis.crypto.randomUUID();
}
