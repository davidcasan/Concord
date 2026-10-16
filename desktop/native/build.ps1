# Compila o minicord-audio.exe (precisa do Visual Studio Build Tools com a carga "Desenvolvimento para desktop com C++").
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio Build Tools com C++ não encontrado.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
Push-Location $PSScriptRoot
try {
  cmd /c "`"$vcvars`" >nul && cl /nologo /O2 /MT /EHsc /std:c++17 /W3 minicord-audio.cpp /Fe:minicord-audio.exe /link /SUBSYSTEM:CONSOLE"
  if ($LASTEXITCODE -ne 0) { throw 'Falha na compilação.' }
  Remove-Item -ErrorAction SilentlyContinue minicord-audio.obj
} finally { Pop-Location }
