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
 * HubSpot CRM adapter (plan: integrations §4). Uses the CRM v3 objects API.
 * Contacts are upserted by email (idempotency-safe); deals/notes/meetings are
 * created and associated. Network errors surface to the sync job's retry logic.
 *
 * This talks to the real HubSpot API; it is exercised in staging against a
 * sandbox portal. Unit/integration tests use FakeCrm.
 */
const BASE = "https://api.hubapi.com";

export class HubSpotCrm implements CrmAdapter {
  private async req(
    conn: CrmConnection,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${conn.accessToken}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`HubSpot ${method} ${path} → ${res.status}`);
    }
    return res.json();
  }

  async upsertContact(conn: CrmConnection, input: ContactInput): Promise<ExternalRef> {
    const properties = {
      firstname: input.firstName ?? undefined,
      lastname: input.lastName ?? undefined,
      email: input.email ?? undefined,
      phone: input.phone ?? undefined,
      stl_source: input.source ?? undefined,
    };
    // Upsert by email when available (idempotent); else create.
    if (input.email) {
      const found = (await this.req(conn, "POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [
          { filters: [{ propertyName: "email", operator: "EQ", value: input.email }] },
        ],
      })) as { results?: { id: string }[] };
      const existing = found.results?.[0];
      if (existing) {
        await this.req(conn, "PATCH", `/crm/v3/objects/contacts/${existing.id}`, { properties });
        return { externalId: existing.id };
      }
    }
    const created = (await this.req(conn, "POST", "/crm/v3/objects/contacts", {
      properties,
    })) as { id: string };
    return { externalId: created.id };
  }

  async upsertDeal(conn: CrmConnection, input: DealInput): Promise<ExternalRef> {
    const properties = {
      dealname: input.name,
      dealstage: input.stage,
      amount: input.amount ?? undefined,
      stl_score: input.score ?? undefined,
      stl_band: input.band ?? undefined,
    };
    if (input.externalId) {
      await this.req(conn, "PATCH", `/crm/v3/objects/deals/${input.externalId}`, { properties });
      return { externalId: input.externalId };
    }
    const created = (await this.req(conn, "POST", "/crm/v3/objects/deals", {
      properties,
      associations: [
        {
          to: { id: input.contactExternalId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
        },
      ],
    })) as { id: string };
    return { externalId: created.id };
  }

  async addNote(conn: CrmConnection, input: NoteInput): Promise<void> {
    await this.req(conn, "POST", "/crm/v3/objects/notes", {
      properties: { hs_note_body: input.body, hs_timestamp: Date.now() },
      associations: [
        {
          to: { id: input.contactExternalId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
        },
      ],
    });
  }

  async createMeeting(conn: CrmConnection, input: MeetingInput): Promise<void> {
    await this.req(conn, "POST", "/crm/v3/objects/meetings", {
      properties: {
        hs_meeting_title: input.title,
        hs_meeting_start_time: input.startsAt.getTime(),
        hs_meeting_end_time: input.endsAt.getTime(),
        hs_timestamp: Date.now(),
      },
      associations: [
        {
          to: { id: input.contactExternalId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 200 }],
        },
      ],
    });
  }
}
