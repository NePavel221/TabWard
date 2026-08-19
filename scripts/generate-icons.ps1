$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $root "apps\extension\icons"
$sizes = @(16, 32, 48, 128, 1024)

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $diameter = $Radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc(
    $X + $Width - $diameter,
    $Y + $Height - $diameter,
    $diameter,
    $diameter,
    0,
    90
  )
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$canvas = New-Object System.Drawing.Bitmap 1024, 1024
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::FromArgb(12, 19, 31))

$bounds = New-Object System.Drawing.Rectangle 0, 0, 1024, 1024
$background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $bounds,
  [System.Drawing.Color]::FromArgb(20, 31, 51),
  [System.Drawing.Color]::FromArgb(8, 14, 24),
  55
)
$graphics.FillRectangle($background, $bounds)

$glow = New-Object System.Drawing.SolidBrush(
  [System.Drawing.Color]::FromArgb(26, 54, 210, 235)
)
$graphics.FillEllipse($glow, 150, 170, 724, 724)

$tabPath = New-RoundedRectanglePath 132 214 760 600 92
$tabFill = New-Object System.Drawing.SolidBrush(
  [System.Drawing.Color]::FromArgb(28, 42, 64)
)
$tabPen = New-Object System.Drawing.Pen(
  [System.Drawing.Color]::FromArgb(74, 222, 245),
  42
)
$tabPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.FillPath($tabFill, $tabPath)
$graphics.DrawPath($tabPen, $tabPath)

$headerPen = New-Object System.Drawing.Pen(
  [System.Drawing.Color]::FromArgb(74, 222, 245),
  34
)
$headerPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$headerPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($headerPen, 178, 356, 846, 356)

$activeTab = New-RoundedRectanglePath 222 150 340 150 56
$activeFill = New-Object System.Drawing.SolidBrush(
  [System.Drawing.Color]::FromArgb(45, 72, 101)
)
$graphics.FillPath($activeFill, $activeTab)
$graphics.DrawPath($tabPen, $activeTab)

$shieldPoints = @(
  (New-Object System.Drawing.PointF 512, 306),
  (New-Object System.Drawing.PointF 690, 378),
  (New-Object System.Drawing.PointF 656, 652),
  (New-Object System.Drawing.PointF 512, 774),
  (New-Object System.Drawing.PointF 368, 652),
  (New-Object System.Drawing.PointF 334, 378)
)
$shieldFill = New-Object System.Drawing.SolidBrush(
  [System.Drawing.Color]::FromArgb(18, 56, 82)
)
$shieldPen = New-Object System.Drawing.Pen(
  [System.Drawing.Color]::FromArgb(116, 236, 249),
  40
)
$shieldPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.FillPolygon($shieldFill, $shieldPoints)
$graphics.DrawPolygon($shieldPen, $shieldPoints)

$checkPen = New-Object System.Drawing.Pen(
  [System.Drawing.Color]::FromArgb(244, 250, 255),
  54
)
$checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawLines($checkPen, @(
  (New-Object System.Drawing.PointF 420, 540),
  (New-Object System.Drawing.PointF 492, 612),
  (New-Object System.Drawing.PointF 616, 474)
))

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

foreach ($size in $sizes) {
  $image = New-Object System.Drawing.Bitmap $size, $size
  $resizer = [System.Drawing.Graphics]::FromImage($image)
  $resizer.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $resizer.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizer.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $resizer.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
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

$checkPen.Dispose()
$shieldPen.Dispose()
$shieldFill.Dispose()
$activeFill.Dispose()
$activeTab.Dispose()
$headerPen.Dispose()
$tabPen.Dispose()
$tabFill.Dispose()
$tabPath.Dispose()
$glow.Dispose()
$background.Dispose()
$graphics.Dispose()
$canvas.Dispose()

Write-Output "Generated TabWard icons: $($sizes -join ', ')"
