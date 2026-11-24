Add-Type -AssemblyName System.Drawing
$dir = "C:\Code\fredo\.opencode\wireframes\blender\previews"
$files = Get-ChildItem $dir -Filter "clip_*.png" | Sort-Object Name
$cellW = 220; $cellH = 275; $labelH = 26; $pad = 12
$cols = 4
$rows = [int][math]::Ceiling($files.Count / $cols)
$out = New-Object System.Drawing.Bitmap ($cellW * $cols + $pad * ($cols + 1)), ($rows * ($cellH + $labelH) + $pad * ($rows + 1))
$g = [System.Drawing.Graphics]::FromImage($out)
$g.Clear([System.Drawing.Color]::FromArgb(255, 6, 10, 14))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$font = New-Object System.Drawing.Font "Consolas", 11, ([System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 120, 235, 245))

for ($i = 0; $i -lt $files.Count; $i++) {
  $img = [System.Drawing.Bitmap]::FromFile($files[$i].FullName)
  $c = $i % $cols; $r = [int][math]::Floor($i / $cols)
  $x = $pad + $c * ($cellW + $pad)
  $y = $pad + $r * ($cellH + $labelH + $pad)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle $x, ($y + $labelH), $cellW, $cellH))
  $label = $files[$i].BaseName -replace '^clip_', '' -replace '_f', '  f'
  $g.DrawString($label.ToUpper(), $font, $brush, [single]$x, [single]$y)
  $img.Dispose()
}
$g.Dispose()
$out.Save("C:\Code\fredo\.opencode\wireframes\blender\previews\clips-sheet.png", [System.Drawing.Imaging.ImageFormat]::Png)
"sheet {0}x{1} from {2} clips" -f $out.Width, $out.Height, $files.Count
$out.Dispose()
