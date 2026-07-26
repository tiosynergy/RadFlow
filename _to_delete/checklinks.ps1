$base = 'D:\RadFlowDev\docs'
$t = Get-Content (Join-Path $base 'README.md') -Raw
$links = [regex]::Matches($t, '\]\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($p in $links) {
  $full = Join-Path $base $p
  $ok = Test-Path -LiteralPath $full
  if ($ok) { Write-Output ("OK   " + $p) } else { Write-Output ("MISS " + $p) }
}
