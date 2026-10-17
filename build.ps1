# Builds Nebula IDE: VSCodium base + Nebula branding + built-in Nebula Agent extension + NSIS installer.
#   pwsh -File build.ps1 [-SkipInstaller]
param([switch]$SkipInstaller)
$ErrorActionPreference = 'Stop'
$here    = $PSScriptRoot
$work    = Join-Path $env:TEMP 'nb'                    # short path: avoids the 260-char limit
$zip     = Join-Path $work 'vscodium.zip'
$stage   = Join-Path $work 'Nebula IDE'
$version = '1.1.0'
$vscodiumUrl = 'https://github.com/VSCodium/vscodium/releases/download/1.140.06880/VSCodium-win32-x64-1.140.06880.zip'
$rcedit   = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe'
$makensis = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis\nsis-3.0.4.1\Bin\makensis.exe'

New-Item -ItemType Directory -Force $work | Out-Null
if (-not (Test-Path (Join-Path $here 'extension\node_modules'))) {
  Write-Host 'Installing extension dependencies...'
  Push-Location (Join-Path $here 'extension'); npm ci --omit=dev; Pop-Location
  if ($LASTEXITCODE) { throw 'npm ci failed' }
}
if (-not (Test-Path $zip)) { Write-Host 'Downloading VSCodium...'; curl.exe -sL -o $zip $vscodiumUrl }

Write-Host 'Staging...'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
Expand-Archive $zip $stage

# ---- branding ----
$app = Join-Path $stage 'resources\app'
$pj = Get-Content "$app\product.json" -Raw | ConvertFrom-Json
$set = @{
  nameShort = 'Nebula IDE'; nameLong = 'Nebula IDE'; applicationName = 'nebula'; dataFolderName = '.nebula-ide'
  win32MutexName = 'nebulaide'; win32AppUserModelId = 'Nebula.NebulaIDE'; win32DirName = 'Nebula IDE'
  win32NameVersion = 'Nebula IDE'; win32RegValueName = 'NebulaIDE'; win32ShellNameShort = 'N&ebula IDE'
  urlProtocol = 'nebula'; serverApplicationName = 'nebula-server'; serverDataFolderName = '.nebula-server'
  tunnelApplicationName = 'nebula-tunnel'; win32TunnelServiceMutex = 'nebula-tunnelservice'; win32TunnelMutex = 'nebula-tunnel'
  licenseUrl = 'https://github.com/VSCodium/vscodium/blob/master/LICENSE'
}
foreach ($k in $set.Keys) { $pj | Add-Member -Force -NotePropertyName $k -NotePropertyValue $set[$k] }
foreach ($k in 'updateUrl', 'downloadUrl', 'releaseNotesUrl', 'win32x64UserAppId', 'win32arm64UserAppId', 'win32x64AppId', 'win32arm64AppId', 'checksums') { $pj.PSObject.Properties.Remove($k) }
$pj | ConvertTo-Json -Depth 32 | Set-Content "$app\product.json" -Encoding utf8

# ---- logos: title bar + empty-editor letterpress ----
Copy-Item (Join-Path $here 'build\code-icon.svg') "$app\out\media\code-icon.svg" -Force
foreach ($v in 'dark', 'hcDark', 'light', 'hcLight') { Copy-Item (Join-Path $here "build\letterpress-$v.svg") "$app\out\media\letterpress-$v.svg" -Force }

# ---- empty-editor watermark: a single "Code with Agent  Ctrl+L" entry, like Antigravity ----
$wbFile = Get-ChildItem "$app\out\vs\workbench" -Filter 'workbench.desktop.main.js' -Recurse | Select-Object -First 1
$wb = [IO.File]::ReadAllText($wbFile.FullName)
$chatEntry = [regex]::Match($wb, '(\w+)=\{text:\w+\(\d+,null\),id:"workbench\.action\.chat\.open",when:\{native:\w+,web:\w+\}\}')
if (-not $chatEntry.Success) { throw 'Watermark chat entry not found - VSCodium version changed?' }
$var = $chatEntry.Groups[1].Value
$wb = $wb.Replace($chatEntry.Value, "$var={text:`"Code with Agent`",id:`"nebula.focusAgent`"}")
$listMatch = [regex]::Match($wb, "(\w+)=\[$var,(\w+)\],")
if (-not $listMatch.Success) { throw 'Watermark list not found' }
$wb = $wb.Replace($listMatch.Value, "$($listMatch.Groups[1].Value)=[$var],")
# no random "tips" padding, and keep our entry even before the extension has registered its command/keybinding
$tips = [regex]::Match($wb, '(\w+)=\[\w+,\w+,\w+,\w+,\w+\],(\w+)=class extends \w+\{constructor\(e,t,i,n,r,a,c\)\{super\(\);this\.keybindingService=t')
if (-not $tips.Success) { throw 'Watermark tips list not found' }
$wb = $wb.Replace($tips.Value, ($tips.Value -replace '^(\w+)=\[[^\]]+\]', '$1=[]'))
foreach ($pair in @(
  @('.filter(i=>!!Ke.getCommand(i.id))', '.filter(i=>i.id==="nebula.focusAgent"||!!Ke.getCommand(i.id))'),
  @('.filter(i=>!!this.keybindingService.lookupKeybinding(i.id))', '.filter(i=>i.id==="nebula.focusAgent"||!!this.keybindingService.lookupKeybinding(i.id))'))) {
  if ($wb.IndexOf($pair[0]) -lt 0) { throw "Watermark filter not found: $($pair[0])" }
  $wb = $wb.Replace($pair[0], $pair[1])
}
[IO.File]::WriteAllText($wbFile.FullName, $wb)

# ---- agent panel header: plain "Agent" title + only the agent's own actions, like Antigravity ----
$css = @'

/* Nebula IDE */
.monaco-workbench .part.auxiliarybar > .composite.title > .global-actions { display: none !important; }
.monaco-workbench .part.auxiliarybar > .composite.title .composite-bar .action-item .action-label { background: transparent !important; font-size: 13px !important; text-transform: none !important; padding-left: 4px !important; }
.monaco-workbench .part.auxiliarybar > .composite.title .composite-bar .action-item .active-item-indicator { display: none !important; }
.monaco-workbench .part.auxiliarybar > .composite.title .composite-bar .action-item.checked .action-label { color: var(--vscode-foreground) !important; }
.monaco-workbench .part.auxiliarybar > .composite.title .title-actions .actions-container > li:has(> .codicon-close) { order: 99; }
.monaco-workbench .part.auxiliarybar > .composite.title .title-actions .actions-container > li:has(> .separator) { display: none !important; }
'@
Add-Content -Path (Join-Path $wbFile.DirectoryName 'workbench.desktop.main.css') -Value $css -Encoding utf8

Rename-Item "$stage\VSCodium.exe" 'Nebula.exe'
Rename-Item "$stage\VSCodium.VisualElementsManifest.xml" 'Nebula.VisualElementsManifest.xml'
(Get-Content "$stage\Nebula.VisualElementsManifest.xml" -Raw) -replace 'VSCodium', 'Nebula IDE' | Set-Content "$stage\Nebula.VisualElementsManifest.xml" -Encoding utf8
$cmd = Get-ChildItem "$stage\bin" -Filter '*.cmd' | Select-Object -First 1
(Get-Content $cmd.FullName -Raw) -replace 'VSCodium\.exe', 'Nebula.exe' -replace 'codium', 'nebula' | Set-Content "$stage\bin\nebula.cmd" -Encoding ascii
Remove-Item $cmd.FullName
Get-ChildItem "$stage\bin" -File | Where-Object { $_.Extension -eq '' } | Remove-Item   # bash launcher for WSL, not needed

# ---- icon ----
$ico = Join-Path $here 'build\nebula.ico'
if (Test-Path $rcedit) {
  & $rcedit "$stage\Nebula.exe" --set-icon $ico --set-version-string ProductName 'Nebula IDE' --set-version-string FileDescription 'Nebula IDE' `
    --set-version-string CompanyName 'Nebula' --set-version-string OriginalFilename 'Nebula.exe' --set-version-string InternalName 'Nebula'
}
Copy-Item $ico "$stage\resources\app\resources\win32\code.ico" -Force

# ---- built-in agent extension ----
$ext = Join-Path $app 'extensions\nebula-agent'
Copy-Item -Recurse (Join-Path $here 'extension') $ext
Get-ChildItem $ext -Recurse -Include *.map, *.pdb, *.d.ts, *.d.mts | Remove-Item -Force

# ---- built-in Remote - SSH (Open VSX), like Antigravity's remote support ----
$sshVsix = Join-Path $work 'open-remote-ssh.vsix'
if (-not (Test-Path $sshVsix)) { curl.exe -sL -o $sshVsix 'https://open-vsx.org/api/jeanp413/open-remote-ssh/0.4.0/file/jeanp413.open-remote-ssh-0.4.0.vsix' }
$sshTmp = Join-Path $work 'ssh-x'
if (Test-Path $sshTmp) { Remove-Item -Recurse -Force $sshTmp }
Copy-Item $sshVsix "$sshVsix.zip" -Force
Expand-Archive "$sshVsix.zip" $sshTmp; Remove-Item "$sshVsix.zip"
Move-Item (Join-Path $sshTmp 'extension') (Join-Path $app 'extensions\open-remote-ssh')
Remove-Item -Recurse -Force $sshTmp

Write-Host "Staged app: $stage"
if ($SkipInstaller) { return }

# ---- installer ----
$out = Join-Path $here 'dist'
New-Item -ItemType Directory -Force $out | Out-Null
& $makensis /V2 "/DSRC=$stage" "/DOUT=$out\Nebula-IDE-Setup-$version.exe" "/DVERSION=$version" "/DICON=$ico" (Join-Path $here 'installer.nsi')
if ($LASTEXITCODE) { throw "makensis failed ($LASTEXITCODE)" }
Write-Host "Installer: $out\Nebula-IDE-Setup-$version.exe"
