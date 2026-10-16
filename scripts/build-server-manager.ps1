$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $root 'server\dist'
$source = Join-Path $root 'server\src\manager\ConcordServerManager.cs'
$core = Join-Path $outputDir 'Concord Server Core.exe'
$icon = Join-Path $root 'desktop\assets\concord.ico'
$addressConfig = Join-Path $root 'desktop\default-server.json'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$output = Join-Path $outputDir 'Concord Server.exe'
$versionFile = Join-Path $outputDir 'Concord Server Core.version'

if (-not (Test-Path $compiler)) {
  throw "Compilador C# do .NET Framework nao encontrado: $compiler"
}
if (-not (Test-Path $core)) {
  throw "Nucleo Concord Server nao encontrado: $core"
}
if (-not (Test-Path $icon)) {
  throw "Icone do Concord nao encontrado: $icon. Rode npm run build-branding primeiro."
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
try {
  $coreHash = (Get-FileHash -LiteralPath $core -Algorithm SHA256).Hash
  [System.IO.File]::WriteAllText($versionFile, $coreHash, [System.Text.UTF8Encoding]::new($false))
  $arguments = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/codepage:65001',
    "/win32icon:$icon",
    "/resource:$core,ConcordServerCore",
    "/resource:$versionFile,ConcordServerCoreVersion",
    "/out:$output",
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll'
  )
  if (Test-Path -LiteralPath $addressConfig) {
    $arguments += "/resource:$addressConfig,ConcordServerAddresses"
  }
  $arguments += $source
  & $compiler @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao compilar o painel Concord Server (csc exit $LASTEXITCODE)."
  }
  Remove-Item -LiteralPath $core -Force
} finally {
  if (Test-Path -LiteralPath $versionFile) {
    Remove-Item -LiteralPath $versionFile -Force
  }
}
Write-Output "Aplicativo Concord Server com nucleo integrado gerado: $output"
