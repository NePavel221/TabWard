param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [Parameter(Mandatory = $true)]
  [string]$DestinationZip
)

$ErrorActionPreference = "Stop"

if (-not [IO.Path]::IsPathRooted($SourceDirectory)) {
  throw "SourceDirectory must be absolute"
}
if (-not [IO.Path]::IsPathRooted($DestinationZip)) {
  throw "DestinationZip must be absolute"
}

$source = [IO.Path]::GetFullPath($SourceDirectory)
$destination = [IO.Path]::GetFullPath($DestinationZip)
if (-not [IO.Directory]::Exists($source)) {
  throw "SourceDirectory does not exist"
}
if ([IO.File]::Exists($destination)) {
  [IO.File]::Delete($destination)
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
  $source,
  $destination,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)

$archive = [IO.Compression.ZipFile]::OpenRead($destination)
try {
  foreach ($entry in $archive.Entries) {
    if (-not [string]::IsNullOrEmpty($entry.Name)) {
      [Console]::Out.WriteLine($entry.FullName)
    }
  }
}
finally {
  $archive.Dispose()
}
