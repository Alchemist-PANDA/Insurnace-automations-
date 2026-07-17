-- Application database role (plan: data-model §5, compliance §3).
--
-- RLS is only enforced for roles that are NOT superuser and NOT BYPASSRLS.
-- The migration owner may be a superuser, but the API/worker MUST connect as
-- this restricted role or tenant isolation is silently disabled.
--
-- Run once per database as the owner, after migrations. Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stl_app') THEN
    CREATE ROLE stl_app LOGIN PASSWORD 'stl_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO stl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stl_app;
