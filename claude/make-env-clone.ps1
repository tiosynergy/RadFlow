# Rehearsal 3.2: build .env.clone from .env.local, replacing ONLY url + anon key.
# Other variables are copied verbatim and never printed.
$ErrorActionPreference = 'Stop'
$root = 'D:\RadFlowDev'
$src  = Join-Path $root '.env.local'
$dst  = Join-Path $root '.env.clone'
$url  = 'https://ompyefikujrihfoeqepi.supabase.co'
$anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tcHllZmlrdWpyaWhmb2VxZXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0ODEzMTAsImV4cCI6MjEwNTA1NzMxMH0.0kUbUlHZnNxzfMrOTzNjKKSACpo8A1tmlHpy-QZMi9Q'

Write-Output '--- env files in repo root:'
Get-ChildItem -Path $root -Force -Filter '.env*' | ForEach-Object { $_.Name }

if (-not (Test-Path $src)) { Write-Output 'ERROR: .env.local NOT FOUND'; exit 1 }

Write-Output '--- variable NAMES in .env.local (values not shown):'
Get-Content $src | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } | ForEach-Object { ($_ -split '=',2)[0].Trim() }

$out = Get-Content $src | ForEach-Object {
  if     ($_ -match '^\s*NEXT_PUBLIC_SUPABASE_URL\s*=')             { "NEXT_PUBLIC_SUPABASE_URL=$url" }
  elseif ($_ -match '^\s*SUPABASE_URL\s*=')                          { "SUPABASE_URL=$url" }
  elseif ($_ -match '^\s*NEXT_PUBLIC_SUPABASE_ANON_KEY\s*=')         { "NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon" }
  elseif ($_ -match '^\s*NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY\s*=')  { "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$anon" }
  elseif ($_ -match '^\s*SUPABASE_SERVICE_ROLE_KEY\s*=')             { 'SUPABASE_SERVICE_ROLE_KEY=DISABLED_FOR_CLONE_REHEARSAL' }
  else { $_ }
}
Set-Content -Path $dst -Value $out -Encoding UTF8

Write-Output '--- .env.clone written. Replaced lines (names only):'
Get-Content $dst | Where-Object { $_ -match 'SUPABASE_URL|ANON_KEY|PUBLISHABLE_KEY|SERVICE_ROLE' } | ForEach-Object { ($_ -split '=',2)[0].Trim() }
