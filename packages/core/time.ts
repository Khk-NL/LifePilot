import { day, clock } from './model';

export function calendarDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shift(date: string, days: number): string {
  const stamp = new Date(day.parse(date) + 'T12:00:00Z');
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}

export function lifeDate(now = new Date()): string {
  const date = calendarDate(now);
  return now.getHours() < 4 ? shift(date, -1) : date;
}

export function monday(date: string): string {
  const offset = (new Date(day.parse(date) + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return shift(date, -offset);
}

export function lifeInstant(date: string, time: string): string {
  return new Date((clock.parse(time) < '04:00' ? shift(date, 1) : day.parse(date)) + 'T' + time).toISOString();
}

export function localInput(iso: string): string {
  const date = new Date(iso);
  return calendarDate(date) + 'T' + date.toTimeString().slice(0, 5);
}

export function elapsed(start: string, finish: string): number {
  return (Date.parse(finish) - Date.parse(start)) / 60_000;
}
