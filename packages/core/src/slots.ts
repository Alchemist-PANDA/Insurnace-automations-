/**
 * Appointment slot-availability engine (plan: integrations §3, PLAN M7). Pure
 * logic: given busy intervals, working windows, appointment duration, and
 * buffers, compute the bookable slots. The calendar adapter only reports
 * busy/free; slot selection lives here so it is unit-testable.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotConfig {
  /** Appointment length in minutes. */
  durationMinutes: number;
  /** Buffer before and after each appointment (travel/prep), minutes. */
  bufferMinutes: number;
  /** Granularity of offered start times, minutes (e.g. 30). */
  stepMinutes: number;
  /** How many slots to offer the lead (2-3 recommended). */
  maxOffers: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Compute candidate slots within the working windows that do not collide with
 * busy intervals (busy expanded by the buffer on both sides).
 */
export function computeSlots(
  workingWindows: Interval[],
  busy: Interval[],
  config: SlotConfig,
  now: Date = new Date(),
): Interval[] {
  const bufferMs = config.bufferMinutes * 60_000;
  const durationMs = config.durationMinutes * 60_000;
  const stepMs = config.stepMinutes * 60_000;

  const expandedBusy = busy.map((b) => ({
    start: new Date(b.start.getTime() - bufferMs),
    end: new Date(b.end.getTime() + bufferMs),
  }));

  const offers: Interval[] = [];
  for (const win of workingWindows) {
    let cursor = win.start.getTime();
    // Never offer a slot in the past.
    cursor = Math.max(cursor, now.getTime());
    // Align the cursor up to the next step boundary from the window start.
    const alignBase = win.start.getTime();
    if ((cursor - alignBase) % stepMs !== 0) {
      cursor = alignBase + Math.ceil((cursor - alignBase) / stepMs) * stepMs;
    }

    while (cursor + durationMs <= win.end.getTime()) {
      const candidate: Interval = {
        start: new Date(cursor),
        end: new Date(cursor + durationMs),
      };
      const collides = expandedBusy.some((b) => overlaps(candidate, b));
      if (!collides) {
        offers.push(candidate);
        if (offers.length >= config.maxOffers) return offers;
      }
      cursor += stepMs;
    }
  }
  return offers;
}
