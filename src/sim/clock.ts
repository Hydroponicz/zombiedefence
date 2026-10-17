// Game time is measured in absolute game minutes from Day 1 00:00.
// A full day takes 30 real minutes: 06:00–20:00 runs over 20 min, 20:00–06:00 over 10 min.

export const MINUTES_PER_DAY = 1440;
export const DAY_START = 6 * 60;
export const NIGHT_START = 20 * 60;
export const DAY_REAL_SECONDS = 20 * 60;
export const NIGHT_REAL_SECONDS = 10 * 60;

const DAY_GAME_MINUTES = NIGHT_START - DAY_START;
const NIGHT_GAME_MINUTES = MINUTES_PER_DAY - DAY_GAME_MINUTES;
const DAY_SEC_PER_MIN = DAY_REAL_SECONDS / DAY_GAME_MINUTES;
const NIGHT_SEC_PER_MIN = NIGHT_REAL_SECONDS / NIGHT_GAME_MINUTES;

/** The game starts on Day 1 at 06:00. */
export const START_MINUTE = DAY_START;

export function minuteOfDay(t: number): number {
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function dayNumber(t: number): number {
  return Math.floor(t / MINUTES_PER_DAY) + 1;
}

export function isDaytime(t: number): boolean {
  const m = minuteOfDay(t);
  return m >= DAY_START && m < NIGHT_START;
}

export function realSecondsPerGameMinute(t: number): number {
  return isDaytime(t) ? DAY_SEC_PER_MIN : NIGHT_SEC_PER_MIN;
}

/** Advance game time by `realSeconds`, accounting for the different day and night rates. */
export function advanceGameTime(t: number, realSeconds: number): number {
  let remaining = realSeconds;
  // Bounded loop: each iteration either finishes or crosses a day/night boundary.
  for (let i = 0; i < 64 && remaining > 0; i++) {
    const m = minuteOfDay(t);
    const day = isDaytime(t);
    const boundary = day ? NIGHT_START : m < DAY_START ? DAY_START : DAY_START + MINUTES_PER_DAY;
    const minutesToBoundary = boundary - m;
    const secPerMin = day ? DAY_SEC_PER_MIN : NIGHT_SEC_PER_MIN;
    const secondsToBoundary = minutesToBoundary * secPerMin;
    if (remaining < secondsToBoundary) {
      return t + remaining / secPerMin;
    }
    t += minutesToBoundary;
    remaining -= secondsToBoundary;
  }
  return t;
}

export function formatClock(t: number): string {
  const m = Math.floor(minuteOfDay(t));
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `Day ${dayNumber(t)} · ${hh}:${mm}`;
}

/**
 * Daylight amount 0..1. Dawn runs 05:00–06:15 so the day starts in daylight; dusk runs 19:45–21:00.
 */
export function daylight(t: number): number {
  const m = minuteOfDay(t);
  const smooth = (x: number) => x * x * (3 - 2 * x);
  const dawnStart = DAY_START - 60;
  const dawnEnd = DAY_START + 15;
  const duskStart = NIGHT_START - 15;
  const duskEnd = NIGHT_START + 60;
  if (m >= dawnEnd && m <= duskStart) return 1;
  if (m > dawnStart && m < dawnEnd) return smooth((m - dawnStart) / (dawnEnd - dawnStart));
  if (m > duskStart && m < duskEnd) return 1 - smooth((m - duskStart) / (duskEnd - duskStart));
  return 0;
}

/** Sun progress across the sky: 0 at 06:00, 1 at 20:00. Outside daytime, moon progress over the night. */
export function skyProgress(t: number): { sun: boolean; p: number } {
  const m = minuteOfDay(t);
  if (isDaytime(t)) return { sun: true, p: (m - DAY_START) / DAY_GAME_MINUTES };
  const nightMinute = m >= NIGHT_START ? m - NIGHT_START : m + (MINUTES_PER_DAY - NIGHT_START);
  return { sun: false, p: nightMinute / NIGHT_GAME_MINUTES };
}
