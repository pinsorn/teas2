-- Run once per PostgreSQL server as the superuser (idempotent). Passwords come from the ENVIRONMENT, never the command line:
--   TEAS_MIGRATOR_PW, TEAS_APP_PW required; TEAS_TEST_ADMIN_PW optional (creates teas_test_admin: local + CI only, never prod)
--   psql -v ON_ERROR_STOP=1 -f bootstrap-roles.sql
-- Roles are NOSUPERUSER NOBYPASSRLS (SP3 4.2).
-- The ALTER ROLE ... PASSWORD statements below must not reach the server log.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';

\getenv migrator_pw TEAS_MIGRATOR_PW
\getenv app_pw TEAS_APP_PW
\getenv test_admin_pw TEAS_TEST_ADMIN_PW

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
