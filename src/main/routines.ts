import type { Routine, RoutineSchedule } from "../shared/contracts";

export const MIN_ROUTINE_INTERVAL_MINUTES = 15;
export const MAX_ENABLED_ROUTINES = 20;
export const ROUTINE_FAILURE_LIMIT = 10;
export const ROUTINE_GRACE_MS = 5 * 60_000;

function validTime(value: string): { hours: number; minutes: number } {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error("Daily routine time must use HH:MM");
  }
  return { hours, minutes };
}

export function normalizeRoutineSchedule(value: RoutineSchedule): RoutineSchedule {
  if (value.kind === "interval") {
    if (!Number.isSafeInteger(value.minutes) || value.minutes < MIN_ROUTINE_INTERVAL_MINUTES || value.minutes > 43_200) {
      throw new Error(`Routine intervals must be between ${MIN_ROUTINE_INTERVAL_MINUTES} minutes and 30 days`);
    }
    return { kind: "interval", minutes: value.minutes };
  }
  const time = validTime(value.time);
  const weekdays = [...new Set(value.weekdays)]
    .filter((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  if (!weekdays.length) throw new Error("Choose at least one day for a daily routine");
  return { kind: "daily", time: `${String(time.hours).padStart(2, "0")}:${String(time.minutes).padStart(2, "0")}`, weekdays };
}

export function nextRoutineOccurrence(scheduleValue: RoutineSchedule, after: number): number {
  const schedule = normalizeRoutineSchedule(scheduleValue);
  if (schedule.kind === "interval") return after + schedule.minutes * 60_000;
  const { hours, minutes } = validTime(schedule.time);
  const base = new Date(after + 1_000);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes, 0, 0);
    if (candidate.getTime() > after && schedule.weekdays.includes(candidate.getDay())) return candidate.getTime();
  }
  throw new Error("Could not compute the routine's next run");
}

export function advancePastMissedOccurrences(routine: Pick<Routine, "schedule" | "nextRunAt">, now: number): number {
  if (routine.nextRunAt > now) return routine.nextRunAt;
  if (routine.schedule.kind === "interval") {
    const normalized = normalizeRoutineSchedule(routine.schedule);
    if (normalized.kind !== "interval") throw new Error("Invalid interval routine");
    const step = normalized.minutes * 60_000;
    return routine.nextRunAt + (Math.floor((now - routine.nextRunAt) / step) + 1) * step;
  }
  return nextRoutineOccurrence(routine.schedule, now);
}

export function isMissedRoutineWindow(scheduledFor: number, now: number): boolean {
  return now - scheduledFor > ROUTINE_GRACE_MS;
}
