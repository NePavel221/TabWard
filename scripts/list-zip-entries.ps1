param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = "Stop"
if (-not [IO.Path]::IsPathRooted($ZipPath)) {
  throw "ZipPath must be absolute"
}

$path = [IO.Path]::GetFullPath($ZipPath)
if (-not [IO.File]::Exists($path)) {
  throw "ZipPath does not exist"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($path)
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
