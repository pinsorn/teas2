# Local PostgreSQL 18 setup: roles (deploy/db/bootstrap-roles.sql) + the teas_dev database owned by teas_migrator.
# Needs $env:PGPASSWORD (the postgres superuser password) and $env:TEAS_DEV_ROLE_PASSWORD (one local-only password
# for the three TEAS roles). Passwords are never printed.
param([int]$Port = 5432, [string]$PgBin = 'S:\Program Files\PostgreSQL\18\bin')
$ErrorActionPreference = 'Stop'
if (-not $env:PGPASSWORD) { throw 'Set $env:PGPASSWORD to the postgres superuser password.' }
if (-not $env:TEAS_DEV_ROLE_PASSWORD) { throw 'Set $env:TEAS_DEV_ROLE_PASSWORD (local-only password for the TEAS roles).' }
$psql = Join-Path $PgBin 'psql.exe'
$pw = $env:TEAS_DEV_ROLE_PASSWORD
$sql = Join-Path $PSScriptRoot '..\..\deploy\db\bootstrap-roles.sql'
& $psql -h localhost -p $Port -U postgres -w -v ON_ERROR_STOP=1 -v "migrator_pw=$pw" -v "app_pw=$pw" -v "test_admin_pw=$pw" -f $sql
if ($LASTEXITCODE -ne 0) { throw 'bootstrap-roles.sql failed' }
$exists = & $psql -h localhost -p $Port -U postgres -w -tA -c "SELECT 1 FROM pg_database WHERE datname = 'teas_dev'"
if (-not $exists) {
  & $psql -h localhost -p $Port -U postgres -w -v ON_ERROR_STOP=1 -c 'CREATE DATABASE teas_dev OWNER teas_migrator'
  if ($LASTEXITCODE -ne 0) { throw 'CREATE DATABASE failed' }
}
"Done. Connection strings (add the password from TEAS_DEV_ROLE_PASSWORD):"
"  TEAS_TEST_ADMIN_CS = Host=localhost;Port=$Port;Database=postgres;Username=teas_test_admin;Password=<pw>"
"  TEAS_TEST_APP_CS   = Host=localhost;Port=$Port;Database=postgres;Username=teas_app;Password=<pw>"
"  migrate: `$env:TEAS_MIGRATOR_CS = 'Host=localhost;Port=$Port;Database=teas_dev;Username=teas_migrator;Password=<pw>'; dotnet run --project backend/src/Teas.Migrator -- migrate"
