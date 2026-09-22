$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $root "apps\extension\icons"
$sizes = @(16, 32, 48, 128, 1024)
$scale = 8

function New-Point {
  param([float]$X, [float]$Y)
  return New-Object System.Drawing.PointF ($X * $scale), ($Y * $scale)
}

function New-Brush {
  param([string]$Color)
  return New-Object System.Drawing.SolidBrush (
    [System.Drawing.ColorTranslator]::FromHtml($Color)
  )
}

function Fill-Polygon {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Brush]$Brush,
    [System.Drawing.PointF[]]$Points
  )
  $Graphics.FillPolygon($Brush, $Points)
}

$canvas = New-Object System.Drawing.Bitmap 1024, 1024
$canvas.SetResolution(96, 96)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$teal = New-Brush "#087F8C"
$red = New-Brush "#D34F38"
$cream = New-Brush "#FFF9EE"
$gold = New-Brush "#A67B28"

Fill-Polygon $graphics $red @(
  (New-Point 48 58),
  (New-Point 80 58),
  (New-Point 90 105),
  (New-Point 38 105)
)

Fill-Polygon $graphics $cream @(
  (New-Point 46 72),
  (New-Point 83 72),
  (New-Point 86 86),
  (New-Point 43 86)
)

Fill-Polygon $graphics $teal @(
  (New-Point 39 35),
  (New-Point 64 14),
  (New-Point 89 35),
  (New-Point 89 48),
  (New-Point 39 48)
)

$lampPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$lampPath.AddArc(55 * $scale, 33 * $scale, 6 * $scale, 6 * $scale, 180, 90)
$lampPath.AddArc(67 * $scale, 33 * $scale, 6 * $scale, 6 * $scale, 270, 90)
$lampPath.AddArc(67 * $scale, 43 * $scale, 6 * $scale, 6 * $scale, 0, 90)
$lampPath.AddArc(55 * $scale, 43 * $scale, 6 * $scale, 6 * $scale, 90, 90)
$lampPath.CloseFigure()
$graphics.FillPath($gold, $lampPath)

Fill-Polygon $graphics $gold @(
  (New-Point 8 34),
  (New-Point 30 40),
  (New-Point 30 51),
  (New-Point 8 57)
)

Fill-Polygon $graphics $gold @(
  (New-Point 120 34),
  (New-Point 98 40),
  (New-Point 98 51),
  (New-Point 120 57)
)

Fill-Polygon $graphics $teal @(
  (New-Point 16 94),
  (New-Point 32 94),
  (New-Point 32 104),
  (New-Point 96 104),
  (New-Point 96 94),
  (New-Point 112 94),
  (New-Point 112 117),
  (New-Point 16 117)
)

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

foreach ($size in $sizes) {
  $image = New-Object System.Drawing.Bitmap $size, $size
  $resizer = [System.Drawing.Graphics]::FromImage($image)
  $resizer.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $resizer.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizer.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $resizer.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $resizer.Clear([System.Drawing.Color]::Transparent)
  $resizer.DrawImage(
    $canvas,
    (New-Object System.Drawing.Rectangle 0, 0, $size, $size),
    0,
    0,
    1024,
    1024,
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $path = Join-Path $outputDirectory "icon$size.png"
  $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $resizer.Dispose()
  $image.Dispose()
}

$lampPath.Dispose()
$gold.Dispose()
$cream.Dispose()
$red.Dispose()
$teal.Dispose()
$graphics.Dispose()
$canvas.Dispose()

Write-Output "Generated TabWard Lighthouse icons: $($sizes -join ', ')"
