-- CI only (the `compose` job): gives the bootstrap admin two companies to be admin of, so the hybrid e2e can switch company. SP3 has no
-- company-creation route yet (the onboarding wizard is SP4), and bootstrap-admin creates a user with no membership.
-- Run as the Postgres SUPERUSER of the CI service container, AFTER `bootstrap-admin` (a superuser bypasses RLS, so no tenant scope is needed;
-- the application roles can only write a tenant row inside a scope, which only the API can set - by design, see ArchitectureTests F3):
--   psql -h localhost -U postgres -d teas -v ON_ERROR_STOP=1 -v email=admin@ci.example.test -f deploy/db/seed-ci.sql
-- NEVER run this against staging or production.
\set ON_ERROR_STOP on
\encoding UTF8

BEGIN;
INSERT INTO teas.companies (id, name) VALUES (gen_random_uuid(), 'บริษัท ซีไอ เอ จำกัด'), (gen_random_uuid(), 'บริษัท ซีไอ บี จำกัด');
INSERT INTO teas.company_members (company_id, user_id, email, name, role_id)
  SELECT c.id, u.id, u.email, u.display_name, 'admin' FROM teas.companies c CROSS JOIN teas.users u
  WHERE u.email = :'email' AND c.name IN ('บริษัท ซีไอ เอ จำกัด', 'บริษัท ซีไอ บี จำกัด');
COMMIT;

-- a row-count probe, not an exit code (an INSERT..SELECT that matched no user would also "succeed"): exactly one membership in each of two companies,
-- or the division by zero stops psql with exit 3
SELECT 1 / (CASE WHEN (SELECT count(DISTINCT m.company_id) FROM teas.company_members m JOIN teas.users u ON u.id = m.user_id WHERE u.email = :'email') = 2 THEN 1 ELSE 0 END) AS seeded_two_companies;
