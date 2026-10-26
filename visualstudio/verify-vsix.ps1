# Checks the built Visual Studio VSIX before anyone installs it. CI runs this on
# every push; the Release workflow runs it on the VSIX it is about to publish.
# The version must be the one in the root package.json, which the project reads
# when it builds, and the Marketplace rules below are ones VsixPublisher enforces
# only at upload time.
param(
  [string]$Path = (Join-Path $PSScriptRoot 'Pacmon.VisualStudio/bin/Release/net472/pacmon-visualstudio.vsix')
)
$ErrorActionPreference = 'Stop'

$version = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$vsix = Resolve-Path $Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($vsix)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  foreach ($required in @('extension.vsixmanifest', 'Pacmon.VisualStudio.dll', 'Pacmon.Core.dll', 'Pacmon.VisualStudio.pkgdef', 'Assets/icon.png')) {
    if ($required -notin $names) { throw "VSIX is missing $required" }
  }
  $entry = $archive.GetEntry('extension.vsixmanifest')
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { $manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
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
  $entry = $archive.GetEntry('Pacmon.VisualStudio.pkgdef')
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { $pkgdef = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($pkgdef -notmatch '"CodeBase"="\$PackageFolder\$\\Pacmon\.VisualStudio\.dll"') {
    throw 'VSIX package registration does not point to Pacmon.VisualStudio.dll.'
  }
  if ($pkgdef -notmatch '"Style"="Tabbed"' -or
      $pkgdef -notmatch '"Window"="3ae79031-e1bc-11d0-8f78-00a0c9110057"') {
    throw 'Depos tool window is not docked with Solution Explorer by default.'
  }
}
finally { $archive.Dispose() }
"$vsix is a valid VSIX for Depos $version."
