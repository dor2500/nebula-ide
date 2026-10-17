# Nebula IDE one-line installer:
#   irm https://raw.githubusercontent.com/dor2500/nebula-ide/main/install.ps1 | iex
# Downloads the latest release, verifies its SHA-256, installs to Program Files (Windows asks for admin approval)
# and launches Nebula IDE.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
  $repo = 'dor2500/nebula-ide'
  $headers = @{ 'User-Agent' = 'nebula-ide-installer' }

  Write-Host ''
  Write-Host '  Nebula IDE installer' -ForegroundColor Magenta
  Write-Host ''

  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -like '*Setup*.exe' } | Select-Object -First 1
  if (-not $asset) { throw "No installer found in the latest release ($($release.tag_name))." }
  $hashAsset = $release.assets | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1

  $out = Join-Path $env:TEMP $asset.name
  Write-Host ("  Downloading {0} ({1:N0} MB)..." -f $release.tag_name, ($asset.size / 1MB))
  Invoke-WebRequest $asset.browser_download_url -OutFile $out -Headers $headers -UseBasicParsing

  if ($hashAsset) {
    $expected = ((Invoke-RestMethod $hashAsset.browser_download_url -Headers $headers) -split '\s+')[0].Trim().ToLower()
    $actual = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { Remove-Item $out -Force; throw 'Checksum mismatch - the download is corrupt or was tampered with. Nothing was installed.' }
    Write-Host '  Checksum verified.'
  }

  Write-Host '  Installing... (approve the Windows admin prompt)'
  $p = Start-Process -FilePath $out -ArgumentList '/S' -Verb RunAs -Wait -PassThru
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)." }

  $exe = Join-Path $env:ProgramFiles 'Nebula IDE\Nebula.exe'
  Write-Host "  Installed to $(Split-Path $exe)" -ForegroundColor Green
  Write-Host '  Starting Nebula IDE...'
  Start-Process $exe
  Write-Host ''
}
