/**
 * CRM adapter contract (plan: integrations §4). The CRM stays the external
 * system of record; we are the system of engagement. Sync is upsert-by-external
 * -id (never blind create) so retries never duplicate. HubSpot is first.
 */

export interface CrmConnection {
  accessToken: string;
  portalId?: string;
}

export interface ContactInput {
  externalId?: string | null; // our mapping's known CRM id, if any
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source?: string | null;
}

export interface DealInput {
  externalId?: string | null;
  contactExternalId: string;
  name: string;
  stage: string;
  amount?: number | null;
  score?: number | null;
  band?: string | null;
}

export interface NoteInput {
  contactExternalId: string;
  body: string;
}

export interface MeetingInput {
  contactExternalId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ExternalRef {
  externalId: string;
}

export interface CrmAdapter {
  upsertContact(conn: CrmConnection, input: ContactInput): Promise<ExternalRef>;
  upsertDeal(conn: CrmConnection, input: DealInput): Promise<ExternalRef>;
  addNote(conn: CrmConnection, input: NoteInput): Promise<void>;
  createMeeting(conn: CrmConnection, input: MeetingInput): Promise<void>;
}
