# Regenerates the resume PDFs from resume/index.html (the single source of truth).
#
#   pwsh ./_scripts/build-resume.ps1
#
# Outputs
#   resume.pdf                                   master version, published at cdfoley.com/resume.pdf
#   applications/Casey-Foley-PhD-Resume-*.pdf    tailored versions (git-ignored, never published)
#
# Phone number: only the tailored (application) PDFs include it. It is read from
# applications/contact.json, e.g. { "phone": "555-555-5555" }, which is git-ignored, so the
# number never appears in the public repository, the web resume, or the public resume.pdf.
#
# Requires Python (for a temporary local web server) and Microsoft Edge.
# Folders starting with "_" are not published by GitHub Pages.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }

$variants = [ordered]@{
    master  = Join-Path $root 'resume.pdf'
    mfg     = Join-Path $root 'applications\Casey-Foley-PhD-Resume-Process-Engineering.pdf'
    rd      = Join-Path $root 'applications\Casey-Foley-PhD-Resume-Optical-RD.pdf'
    inspect = Join-Path $root 'applications\Casey-Foley-PhD-Resume-Inspection-Metrology.pdf'
}
New-Item -ItemType Directory -Force (Join-Path $root 'applications') | Out-Null

$phone = $null
$contactFile = Join-Path $root 'applications\contact.json'
if (Test-Path $contactFile) { $phone = (Get-Content $contactFile -Raw | ConvertFrom-Json).phone }
if (-not $phone) { Write-Warning "No phone in $contactFile; tailored PDFs will omit it." }

$port = Get-Random -Minimum 20000 -Maximum 40000
$server = Start-Process python -ArgumentList '-m', 'http.server', $port, '--bind', '127.0.0.1' `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        try { Invoke-WebRequest "http://127.0.0.1:$port/resume/" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) { throw "Local server did not start on port $port." }

    foreach ($v in $variants.Keys) {
        $out = $variants[$v]
        $url = "http://127.0.0.1:$port/resume/?v=$v&print"
        if ($v -ne 'master' -and $phone) { $url += '&phone=' + [uri]::EscapeDataString($phone) }
        $edgeProfile = Join-Path ([IO.Path]::GetTempPath()) ("edge-pdf-" + [guid]::NewGuid())
        & $edge --headless=new --disable-gpu --no-first-run --disable-extensions "--user-data-dir=$edgeProfile" `
            --no-pdf-header-footer --virtual-time-budget=10000 "--print-to-pdf=$out" `
            $url 2>$null | Out-Null
        Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
        if (Test-Path $out) { Write-Host "  $v -> $out" } else { Write-Warning "Failed to render $v" }
    }
}
finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
