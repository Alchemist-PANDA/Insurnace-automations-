import type {
  CrmAdapter,
  CrmConnection,
  ContactInput,
  DealInput,
  NoteInput,
  MeetingInput,
  ExternalRef,
} from "./types.js";

/**
 * In-memory CRM for tests/offline dev (plan: testing §1). Upserts are keyed by
 * (email|phone) so a retry with the same identity updates rather than
 * duplicates — mirroring the real upsert-by-external-id contract. A scriptable
 * failure exercises the sync-retry path.
 */
export class FakeCrm implements CrmAdapter {
  readonly contacts = new Map<string, ContactInput & { externalId: string }>();
  readonly deals = new Map<string, DealInput & { externalId: string }>();
  readonly notes: NoteInput[] = [];
  readonly meetings: MeetingInput[] = [];
  private failNext = 0;

  /** Force the next N calls to throw (simulate a provider outage). */
  failFor(n: number): void {
    this.failNext = n;
  }

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("fake CRM transient failure");
    }
  }

  async upsertContact(_c: CrmConnection, input: ContactInput): Promise<ExternalRef> {
    this.maybeFail();
    const key = input.externalId ?? input.email ?? input.phone ?? crypto.randomUUID();
    const externalId = input.externalId ?? `contact_${key}`;
    this.contacts.set(externalId, { ...input, externalId });
    return { externalId };
  }

  async upsertDeal(_c: CrmConnection, input: DealInput): Promise<ExternalRef> {
    this.maybeFail();
    const externalId = input.externalId ?? `deal_${input.contactExternalId}`;
    this.deals.set(externalId, { ...input, externalId });
    return { externalId };
  }

  async addNote(_c: CrmConnection, input: NoteInput): Promise<void> {
    this.maybeFail();
    this.notes.push(input);
  }

  async createMeeting(_c: CrmConnection, input: MeetingInput): Promise<void> {
    this.maybeFail();
    this.meetings.push(input);
  }
}
