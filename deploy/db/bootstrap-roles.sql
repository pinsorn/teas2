-- Run once per PostgreSQL server as the superuser (idempotent):
--   psql -v ON_ERROR_STOP=1 -v migrator_pw=... -v app_pw=... [-v test_admin_pw=...] -f bootstrap-roles.sql
-- teas_test_admin exists only when test_admin_pw is given (local + CI, never prod).
-- Roles are NOSUPERUSER NOBYPASSRLS (SP3 4.2); the passwords come from psql variables, never from this file.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r)
FROM (VALUES ('teas_migrator'), ('teas_app')) AS t(r)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r) \gexec

ALTER ROLE teas_migrator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'migrator_pw';
ALTER ROLE teas_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_pw';

\if :{?test_admin_pw}
SELECT 'CREATE ROLE teas_test_admin LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teas_test_admin') \gexec
ALTER ROLE teas_test_admin LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD :'test_admin_pw';
-- the harness creates template/clone databases owned by teas_migrator and migrates as it (SET ROLE)
GRANT teas_migrator TO teas_test_admin;
\endif
