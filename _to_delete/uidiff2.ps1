Set-Location D:\RadFlowDev
$env:GIT_PAGER = 'cat'
$out = & git --no-optional-locks diff -U1 -- styles/prototype/radflow.css components/RadiologistBoard.tsx 2>&1
[System.IO.File]::WriteAllLines('D:\RadFlowDev\_to_delete\uidiff2.txt', $out, [System.Text.UTF8Encoding]::new($false))
