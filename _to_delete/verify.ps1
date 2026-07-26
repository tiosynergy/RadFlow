$checks = @(
  @{ f = 'D:\RadFlowDev\AGENTS.md';                     pat = 'Обновлено \*\*2026-07-26' },
  @{ f = 'D:\RadFlowDev\AGENTS.md';                     pat = 'MEMORY\.md' },
  @{ f = 'D:\RadFlowDev\AGENTS.md';                     pat = '0040' },
  @{ f = 'D:\RadFlowDev\NEXT_SESSION_PROMPT.md';        pat = 'f0d8f49' },
  @{ f = 'D:\RadFlowDev\NEXT_SESSION_PROMPT.md';        pat = 'project_memory_read' },
  @{ f = 'D:\RadFlowDev\NEXT_SESSION_PROMPT.md';        pat = 'Desktop Commander' },
  @{ f = 'D:\RadFlowDev\NEXT_SESSION_PROMPT.md';        pat = 'trig_01L5Afkqe8kcvTHmTVEcUmRk' },
  @{ f = 'D:\RadFlowDev\docs\HANDOVER.md';              pat = 'сессия 9, финал' },
  @{ f = 'D:\RadFlowDev\docs\HANDOVER.md';              pat = 'origin/main` = `57a83d2' },
  @{ f = 'D:\RadFlowDev\docs\AGENT_ONBOARDING.md';      pat = '0001–0119 ALL APPLIED' }
)
foreach ($c in $checks) {
  $n = (Select-String -LiteralPath $c.f -Pattern $c.pat -AllMatches | Measure-Object).Count
  Write-Output ("{0,-38} {1,-32} hits={2}" -f (Split-Path $c.f -Leaf), $c.pat, $n)
}
Write-Output '--- encoding sanity (first line of each) ---'
foreach ($f in 'D:\RadFlowDev\AGENTS.md','D:\RadFlowDev\NEXT_SESSION_PROMPT.md') {
  Write-Output ((Get-Content -LiteralPath $f -TotalCount 1) -join '')
}
