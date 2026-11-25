# Live Lyrics - now playing from Windows' media controls (SMTC).
#
# Prints one JSON line whenever the song, its position anchor or play state changes:
#   {"present":true,"title":..,"artist":..,"album":..,"durationMs":..,"positionMs":..,
#    "anchorMs":..,"isPlaying":..,"app":..,"cover":"data:image/..."}
# positionMs is where the song was at anchorMs (Unix ms), so the relay and the wallpaper can
# extrapolate exactly instead of trusting a position that may be seconds old.
#
# Follows the session that is playing (Spotify first). Commands written by the relay to
# smtc-command.txt next to this script are run on that session: toggle, play, pause, next,
# previous, "seek <ms>".

$ErrorActionPreference = 'Stop'
$commandFile = Join-Path $PSScriptRoot 'smtc-command.txt'

function Out-Line($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(5000); $t.Result }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if (-not $mgr) { throw 'Windows media controls did not answer' }
} catch {
  [Console]::Error.WriteLine("SMTC unavailable: $($_.Exception.Message)")
  exit 1
}
$ErrorActionPreference = 'Continue'

function Get-Session {
  $sessions = @($mgr.GetSessions())
  $playing = { param($s) $s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing' }
  $s = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' -and (& $playing $_) } | Select-Object -First 1
  if (-not $s) { $s = $sessions | Where-Object { & $playing $_ } | Select-Object -First 1 }
  if (-not $s) { $s = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1 }
  if (-not $s) { $s = $mgr.GetCurrentSession() }
  $s
}

function Get-Cover($props) {
  if (-not $props.Thumbnail) { return '' }
  try {
    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $size = [uint32]$stream.Size
    if ($size -le 0 -or $size -gt 3MB) { $stream.Dispose(); return '' }
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $null = Await ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $reader.Dispose(); $stream.Dispose()
    $type = if ($bytes.Length -gt 3 -and $bytes[0] -eq 0x89) { 'image/png' } else { 'image/jpeg' }
    return "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { return '' }
}

$lastSent = ''
$lastKey = ''
$cover = ''
$lastBeat = [DateTime]::UtcNow
$coverSentFor = ''

while ($true) {
  try {
    $s = Get-Session

    if (Test-Path $commandFile) {
      $c = ([string](Get-Content $commandFile -Raw -ErrorAction SilentlyContinue)).Trim()
      Remove-Item $commandFile -Force -ErrorAction SilentlyContinue
      if ($s) {
        switch -regex ($c) {
          '^toggle$' { $null = $s.TryTogglePlayPauseAsync() }
          '^play$' { $null = $s.TryPlayAsync() }
          '^pause$' { $null = $s.TryPauseAsync() }
          '^next$' { $null = $s.TrySkipNextAsync() }
          '^previous$' { $null = $s.TrySkipPreviousAsync() }
          '^seek (\d+)$' { $null = $s.TryChangePlaybackPositionAsync([long]$matches[1] * 10000) }
        }
      }
    }

    $out = @{ present = $false }
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ($p -and $p.Title) {
        $tl = $s.GetTimelineProperties()
        $isPlaying = $s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
        $key = "$($p.Artist)|$($p.Title)"
        if ($key -ne $lastKey) { $lastKey = $key; $cover = Get-Cover $p }
        $anchor = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        # Some players never stamp the timeline: anchor on now instead of 1601.
        if ($anchor -lt 946684800000 -or $anchor -gt $now + 5000) { $anchor = $now }
        $out = @{
          present    = $true
          app        = [string]$s.SourceAppUserModelId
          title      = [string]$p.Title
          artist     = [string]$(if ($p.Artist) { $p.Artist } else { $p.AlbumArtist })
          album      = [string]$p.AlbumTitle
          durationMs = [long]($tl.EndTime.TotalMilliseconds - $tl.StartTime.TotalMilliseconds)
          positionMs = [long]$tl.Position.TotalMilliseconds
          anchorMs   = $anchor
          isPlaying  = $isPlaying
        }
      }
    }

    $sig = "$($out.present)|$($out.title)|$($out.artist)|$($out.positionMs)|$($out.anchorMs)|$($out.isPlaying)"
    if ($sig -ne $lastSent -or ([DateTime]::UtcNow - $lastBeat).TotalSeconds -ge 10) {
      $lastSent = $sig
      $lastBeat = [DateTime]::UtcNow
      # The cover goes once per song (it is large); the relay keeps it.
      if ($out.present -and $coverSentFor -ne $lastKey) { $out.cover = $cover; $coverSentFor = $lastKey }
      Out-Line $out
    }
  } catch {
    [Console]::Error.WriteLine("tick: $($_.Exception.Message)")
  }
  Start-Sleep -Milliseconds 400
}
