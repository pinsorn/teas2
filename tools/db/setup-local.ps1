# Local PostgreSQL 18 setup: roles (deploy/db/bootstrap-roles.sql) + the teas_dev database owned by teas_migrator.
# Needs $env:PGPASSWORD (the postgres superuser password) and $env:TEAS_DEV_ROLE_PASSWORD (one local-only password
# for the three TEAS roles). Passwords travel by environment only (psql \getenv), never on a command line, and are never printed.
param([int]$Port = 5432, [string]$PgBin = 'S:\Program Files\PostgreSQL\18\bin')
$ErrorActionPreference = 'Stop'
if (-not $env:PGPASSWORD) { throw 'Set $env:PGPASSWORD to the postgres superuser password.' }
if (-not $env:TEAS_DEV_ROLE_PASSWORD) { throw 'Set $env:TEAS_DEV_ROLE_PASSWORD (local-only password for the TEAS roles).' }
$psql = Join-Path $PgBin 'psql.exe'
$sql = Join-Path $PSScriptRoot '..\..\deploy\db\bootstrap-roles.sql'
$env:TEAS_MIGRATOR_PW = $env:TEAS_DEV_ROLE_PASSWORD
$env:TEAS_APP_PW = $env:TEAS_DEV_ROLE_PASSWORD
$env:TEAS_TEST_ADMIN_PW = $env:TEAS_DEV_ROLE_PASSWORD
try {
  & $psql -h localhost -p $Port -U postgres -w -v ON_ERROR_STOP=1 -f $sql
  if ($LASTEXITCODE -ne 0) { throw 'bootstrap-roles.sql failed' }
} finally {
  Remove-Item Env:TEAS_MIGRATOR_PW, Env:TEAS_APP_PW, Env:TEAS_TEST_ADMIN_PW -ErrorAction SilentlyContinue
}
$exists = & $psql -h localhost -p $Port -U postgres -w -tA -c "SELECT 1 FROM pg_database WHERE datname = 'teas_dev'"
if (-not $exists) {
  & $psql -h localhost -p $Port -U postgres -w -v ON_ERROR_STOP=1 -c 'CREATE DATABASE teas_dev OWNER teas_migrator'
  if ($LASTEXITCODE -ne 0) { throw 'CREATE DATABASE failed' }
}
"Done. Connection strings (add the password from TEAS_DEV_ROLE_PASSWORD):"
"  TEAS_TEST_ADMIN_CS = Host=localhost;Port=$Port;Database=postgres;Username=teas_test_admin;Password=<pw>"
"  TEAS_TEST_APP_CS   = Host=localhost;Port=$Port;Database=postgres;Username=teas_app;Password=<pw>"
"  migrate: `$env:TEAS_MIGRATOR_CS = 'Host=localhost;Port=$Port;Database=teas_dev;Username=teas_migrator;Password=<pw>'; dotnet run --project backend/src/Teas.Migrator -- migrate"
"Optional S16 probe (a REAL BYPASSRLS login, local and CI only, never prod): CREATE ROLE teas_bypass_probe LOGIN BYPASSRLS PASSWORD '<same pw>'"
