param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$history = Join-Path $root 'output/history'
$report = [Collections.Generic.List[object]]::new()
function Assert-LocalPath([string]$path) {
  $absolute = [IO.Path]::GetFullPath($path)
  if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Outside project: $path" }
  return $absolute
}
function Archive-Verified([string]$relative) {
  $path = Assert-LocalPath (Join-Path $root $relative)
  if (-not (Test-Path -LiteralPath $path)) { return }
  $items = @(Get-ChildItem -LiteralPath $path -Force -Recurse)
  if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "Refusing linked archive input: $relative" }
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  if (-not $files.Count) { return }
  $bytes = ($files | Measure-Object Length -Sum).Sum
  if (-not $Apply) { $report.Add(@{ action='archive'; path=$relative; files=$files.Count; bytes=$bytes }); return }
  New-Item -ItemType Directory -Path $history -Force | Out-Null
  $zipPath = Assert-LocalPath (Join-Path $history (($relative -replace '[\\/.]', '-') + '-' + $stamp + '.zip'))
  [IO.Compression.ZipFile]::CreateFromDirectory($path, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    if ($entries.Count -ne $files.Count) { throw 'Archive file count mismatch' }
    foreach ($file in $files) {
      $name = [IO.Path]::GetRelativePath($path, $file.FullName).Replace('\','/')
      $entry = $zip.GetEntry($name)
      if (-not $entry -or $entry.Length -ne $file.Length) { throw "Archive entry mismatch: $name" }
      $stream = $entry.Open()
      try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
      if ($hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "Archive hash mismatch: $name" }
    }
  } finally { $zip.Dispose() }
  # Remove only exact inventoried files after byte-for-byte archive validation.
  foreach ($file in $files) { Remove-Item -LiteralPath (Assert-LocalPath $file.FullName) -Force }
  foreach ($dir in @($items | Where-Object PSIsContainer | Sort-Object { $_.FullName.Length } -Descending)) {
    if (-not (Get-ChildItem -LiteralPath $dir.FullName -Force | Select-Object -First 1)) { Remove-Item -LiteralPath (Assert-LocalPath $dir.FullName) -Force }
  }
  $report.Add(@{ action='archived'; path=$relative; files=$files.Count; originalBytes=$bytes; archiveBytes=(Get-Item -LiteralPath $zipPath).Length; archive=[IO.Path]::GetRelativePath($root,$zipPath) })
}

Archive-Verified 'output/archive'
Archive-Verified '.playwright-cli'
# An unpacked Linux Docker tool cache is redundant when remote Docker is used.
# Archive it independently; preserve its config directory and any credential data.
Archive-Verified '.cache-tools/docker/docker'

$artifacts = Assert-LocalPath (Join-Path $root 'output/artifacts')
$files = @(Get-ChildItem -LiteralPath (Join-Path $root 'output') -File -Recurse | Where-Object {
  $_.Name -in @('go-echo-linux','go-sdk-linux.test') -and -not $_.FullName.StartsWith($artifacts + [IO.Path]::DirectorySeparatorChar)
})
foreach ($group in @($files | Group-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })) {
  if ($group.Count -lt 2) { continue }
  $bytes = $group.Group[0].Length
  if (-not $Apply) { $report.Add(@{action='deduplicate'; files=$group.Count; bytes=$bytes*($group.Count-1)}); continue }
  New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
  $canonical = Assert-LocalPath (Join-Path $artifacts ($group.Name.ToLowerInvariant() + '.bin'))
  if (-not (Test-Path -LiteralPath $canonical)) { Copy-Item -LiteralPath $group.Group[0].FullName -Destination $canonical }
  if ((Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash -ne $group.Name) { throw 'Canonical artifact hash mismatch' }
  foreach ($file in $group.Group) {
    $target = Assert-LocalPath $file.FullName
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $group.Name) { throw 'Artifact changed during cleanup' }
    # Content-addressed artifacts are immutable, preserving all historical paths.
    Remove-Item -LiteralPath $target -Force
    New-Item -ItemType HardLink -Path $target -Target $canonical | Out-Null
  }
  (Get-Item -LiteralPath $canonical).IsReadOnly = $true
  $report.Add(@{action='deduplicated'; files=$group.Count; sharedBytes=$bytes; avoidedBytes=$bytes*($group.Count-1); sha256=$group.Name.ToLowerInvariant()})
}
$result = @{ applied=[bool]$Apply; operations=@($report) }
if ($Apply) {
  $reportPath = Assert-LocalPath (Join-Path $history ('cleanup-' + $stamp + '.json'))
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
$result | ConvertTo-Json -Depth 6
