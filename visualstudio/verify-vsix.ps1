# Checks the built Visual Studio VSIX before anyone installs it. CI runs this on
# every push; the Release workflow runs it on the VSIX it is about to publish.
# The version must be the one in the root package.json, which the project reads
# when it builds, and the Marketplace rules below are ones VsixPublisher enforces
# only at upload time.
param(
  [string]$Path = (Join-Path $PSScriptRoot 'Depos.VisualStudio/bin/Release/net472/depos-visualstudio.vsix')
)
$ErrorActionPreference = 'Stop'

$version = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$vsix = Resolve-Path $Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($vsix)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  foreach ($required in @('extension.vsixmanifest', 'Depos.VisualStudio.dll', 'Depos.Core.dll', 'Depos.VisualStudio.pkgdef', 'Assets/icon.png')) {
    if ($required -notin $names) { throw "VSIX is missing $required" }
  }
  # Visual Studio loads its own Newtonsoft.Json; a second copy in the VSIX could load beside it.
  if ('Newtonsoft.Json.dll' -in $names) { throw 'VSIX carries Newtonsoft.Json.dll; Visual Studio provides it.' }
  $entry = $archive.GetEntry('extension.vsixmanifest')
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { $manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  # The identity from before Pacmon became Depos: installed copies update to this VSIX.
  if ($manifest -notmatch 'Id="dev\.pacmon\.visualstudio"') { throw 'VSIX identity is wrong.' }
  if ($manifest -notmatch 'Version="\[17\.0,\)"') { throw 'VSIX does not target Visual Studio 17.0+.' }
  if ($manifest -notmatch '<ProductArchitecture>amd64</ProductArchitecture>' -or
      $manifest -notmatch '<ProductArchitecture>arm64</ProductArchitecture>') {
    throw 'VSIX architecture targets are incomplete.'
  }
  $metadata = ([xml]$manifest).PackageManifest.Metadata
  if ($metadata.Identity.Version -ne $version) {
    throw "VSIX version is $($metadata.Identity.Version), but package.json says $version."
  }
  # The Marketplace refuses a VSIX whose publisher is not the display name of
  # the Marketplace publisher (Kontra), whose description is over 280
  # characters, or with a tag over 50. Tags are separated by semicolons, 100
  # characters in all.
  if ($metadata.Identity.Publisher -cne 'Kontra') {
    throw "VSIX publisher is '$($metadata.Identity.Publisher)', not the Marketplace publisher's display name 'Kontra'."
  }
  $description = $metadata['Description'].InnerText
  if ($description.Length -gt 280) {
    throw "VSIX description is $($description.Length) characters; the Marketplace allows 280."
  }
  $tags = "$($metadata['Tags'].InnerText)"
  if ($tags.Length -gt 100) {
    throw "VSIX tags are $($tags.Length) characters; the manifest allows 100."
  }
  foreach ($tag in $tags.Split(';')) {
    if ($tag.Trim().Length -gt 50) {
      throw "VSIX tag '$($tag.Trim())' is over 50 characters; tags are separated by semicolons, 50 characters each."
    }
  }
  # The command table is found by the name ProvideMenuResource gives; under any other name no command shows.
  $entry = $archive.GetEntry('Depos.VisualStudio.dll')
  $memory = [System.IO.MemoryStream]::new()
  $stream = $entry.Open()
  try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
  $assembly = [System.Reflection.Assembly]::Load($memory.ToArray())
  $menus = $false
  foreach ($name in $assembly.GetManifestResourceNames()) {
    if ($name -notlike '*.resources') { continue }
    $reader = [System.Resources.ResourceReader]::new($assembly.GetManifestResourceStream($name))
    try { foreach ($item in $reader) { if ($item.Key -eq 'Menus.ctmenu') { $menus = $true } } } finally { $reader.Close() }
  }
  if (-not $menus) { throw 'Depos.VisualStudio.dll has no Menus.ctmenu resource, so Visual Studio would show none of its commands.' }
  $entry = $archive.GetEntry('Depos.VisualStudio.pkgdef')
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { $pkgdef = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($pkgdef -notmatch '"CodeBase"="\$PackageFolder\$\\Depos\.VisualStudio\.dll"') {
    throw 'VSIX package registration does not point to Depos.VisualStudio.dll.'
  }
  if ($pkgdef -notmatch '"Style"="Tabbed"' -or
      $pkgdef -notmatch '"Window"="3ae79031-e1bc-11d0-8f78-00a0c9110057"') {
    throw 'Depos tool window is not docked with Solution Explorer by default.'
  }
  # Visual Studio keeps the package's state and where the tool window is docked
  # under these GUIDs, the ones from before Pacmon became Depos.
  if ($pkgdef -notmatch '\\Packages\\\{0d148b7e-b648-46aa-92ef-e401d72ae221\}\]' -or
      $pkgdef -notmatch '\\ToolWindows\\\{af380955-b17d-4614-a349-bc9e50c29a6e\}\]') {
    throw 'VSIX does not register the package and tool window GUIDs from before Pacmon became Depos.'
  }
}
finally { $archive.Dispose() }
"$vsix is a valid VSIX for Depos $version."
