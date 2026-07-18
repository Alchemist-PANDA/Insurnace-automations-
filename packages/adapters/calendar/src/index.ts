import type { Interval } from "@stl/core";

/**
 * CalendarProvider contract (plan: integrations §3). The adapter only reports
 * busy intervals and writes events; slot computation is core logic. Google
 * Calendar is the first real implementation; the fake backs tests/offline dev.
 */
export interface CalendarConnection {
  calendarId: string;
  accessToken: string;
}

export interface CalendarEvent {
  summary: string;
  start: Date;
  end: Date;
  attendeeEmail?: string | null;
  description?: string;
}

export interface CalendarProvider {
  freeBusy(conn: CalendarConnection, window: Interval): Promise<Interval[]>;
  createEvent(conn: CalendarConnection, event: CalendarEvent): Promise<{ externalEventId: string }>;
  cancelEvent(conn: CalendarConnection, externalEventId: string): Promise<void>;
}

/**
 * In-memory calendar for tests (plan: testing §1/§4). Scriptable busy intervals
 * and a hook to inject a concurrent booking between availability check and
 * event creation, exercising the DB slot-hold race guard.
 */
export class FakeCalendar implements CalendarProvider {
  private busy: Interval[] = [];
  readonly created: (CalendarEvent & { externalEventId: string })[] = [];
  private onCreate?: () => Promise<void>;

  setBusy(intervals: Interval[]): void {
    this.busy = intervals;
  }

  /** Injected side effect fired inside createEvent (simulates a race). */
  injectBeforeCreate(fn: () => Promise<void>): void {
    this.onCreate = fn;
  }

  async freeBusy(_conn: CalendarConnection, window: Interval): Promise<Interval[]> {
    return this.busy.filter((b) => b.start < window.end && window.start < b.end);
  }

  async createEvent(
    _conn: CalendarConnection,
    event: CalendarEvent,
  ): Promise<{ externalEventId: string }> {
    if (this.onCreate) {
      const fn = this.onCreate;
      this.onCreate = undefined;
      await fn();
    }
    const externalEventId = `evt_${this.created.length + 1}`;
    this.created.push({ ...event, externalEventId });
    return { externalEventId };
  }

  async cancelEvent(_conn: CalendarConnection, externalEventId: string): Promise<void> {
    const i = this.created.findIndex((e) => e.externalEventId === externalEventId);
    if (i >= 0) this.created.splice(i, 1);
  }
}
