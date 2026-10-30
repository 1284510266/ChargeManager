param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$OutFile = "",
    [string]$Lang = "zh-CN"
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    if ($OutFile -ne "") {
        ([ordered]@{ error = $msg }) | ConvertTo-Json -Compress | Out-File -FilePath $OutFile -Encoding utf8
    }
    else {
        Write-Output ('{"error":"' + $msg + '"}')
    }
    exit 1
}

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Fail "image not found"
}

try {
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
}
catch {
    Fail ("winrt load failed: " + $_.Exception.Message)
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $engine = $null
    if ($Lang -ne "") {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
    }
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
            if ($null -ne $engine) { break }
        }
    }
    if ($null -eq $engine) {
        Fail "no ocr engine available"
    }

    $result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $result.Lines) {
        $lines += $line.Text
    }
    $out = [ordered]@{
        text  = $result.Text
        lines = $lines
        lang  = $engine.RecognizerLanguage.LanguageTag
    }
    $json = $out | ConvertTo-Json -Compress -Depth 4
    if ($OutFile -ne "") {
        $json | Out-File -FilePath $OutFile -Encoding utf8
    }
    else {
        Write-Output $json
    }
}
catch {
    Fail ("ocr failed: " + $_.Exception.Message)
}
