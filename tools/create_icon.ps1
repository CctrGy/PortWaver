param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$icon = $null
$stream = $null

try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scale = [Math]::Min(256.0 / $sourceImage.Width, 256.0 / $sourceImage.Height)
    $width = [int]($sourceImage.Width * $scale)
    $height = [int]($sourceImage.Height * $scale)
    $x = [int]((256 - $width) / 2)
    $y = [int]((256 - $height) / 2)
    $graphics.DrawImage($sourceImage, $x, $y, $width, $height)

    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    $stream = [System.IO.File]::Open($destinationPath, [System.IO.FileMode]::Create)
    $icon.Save($stream)
}
finally {
    if ($stream) { $stream.Dispose() }
    if ($icon) { $icon.Dispose() }
    $graphics.Dispose()
    $bitmap.Dispose()
    $sourceImage.Dispose()
}

$validation = New-Object System.Drawing.Icon($destinationPath)
try {
    if ($validation.Width -ne 256 -or $validation.Height -ne 256) {
        throw "The generated icon is not 256x256."
    }
}
finally {
    $validation.Dispose()
}

Write-Output "Generated icon: $destinationPath"
