param([string]$Script = "C:\Users\User\AppData\Local\Temp\kt-demo\script.json", [string]$OutDir = "C:\Users\User\AppData\Local\Temp\kt-demo\vo", [string]$Voice = "Microsoft Zira Desktop", [int]$Rate = 0)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem $OutDir -Filter *.wav | Remove-Item -Force
$data = Get-Content $Script -Raw | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($Voice)
$synth.Rate = $Rate
$synth.Volume = 100
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($scene in $data.scenes) {
  $i = 0
  foreach ($line in $scene.lines) {
    $path = Join-Path $OutDir ("{0}_{1:00}.wav" -f $scene.id, $i)
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak($line)
    $synth.SetOutputToNull()
    $i++
  }
}
$synth.Dispose()
Get-ChildItem $OutDir -Filter *.wav | Measure-Object | ForEach-Object { "wrote " + $_.Count + " clips" }
