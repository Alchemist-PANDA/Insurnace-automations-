-- Row-level security policies (plan: data-model §5, compliance §3).
--
-- The application DB role is NOT granted BYPASSRLS. Every tenant-scoped table
-- filters on current_setting('app.tenant_id'). No setting → no rows. A
-- platform-admin escape hatch is gated on an explicit, audited session flag.
--
-- Applied idempotently by migrate.ts after Drizzle migrations.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_settings','memberships','lead_sources','raw_webhooks',
    'ingest_idempotency','leads','lead_events','lead_identities',
    'consent_records','conversations','messages','message_delivery_events',
    'message_templates','outbox','lead_scores','audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.platform_admin', true) = 'on'
          OR tenant_id = current_setting('app.tenant_id', true)::uuid
        )
        WITH CHECK (
          current_setting('app.platform_admin', true) = 'on'
          OR tenant_id = current_setting('app.tenant_id', true)::uuid
        )
    $f$, t);
  END LOOP;
END $$;
