$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$requestText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($requestText) -or $requestText.Length -gt 8000000) { throw "A bounded Qwen request is required on standard input." }
try {
  $payload = $requestText | ConvertFrom-Json
  if ($payload.model -ne "hauhaucs-qwen3.8:27b-q4kp-mtp") { throw "Unexpected Qwen model." }
  if ($payload.stream -ne $false -or $payload.temperature -ne 0.2 -or $payload.seed -ne 0) { throw "Qwen sampling controls are not fixed." }
  if ($payload.top_p -ne 0.95 -or $payload.top_k -ne 40 -or $payload.min_p -ne 0) { throw "Qwen sampling controls are not fixed." }
  if ($payload.response_format.type -ne "json_object" -or -not $payload.response_format.schema) { throw "Qwen requires the installed json_object schema dialect." }
  $payload.messages[0].content = "$($payload.messages[0].content)`n/no_think"
  $payload.temperature = 0.7
  $payload.top_p = 0.8
  $payload.top_k = 20
  $spec = [ordered]@{
    source = "family-history-model-eval:qwen-27b"
    profile = "qwen-27b"
    runner = "qwen"
    arguments = @()
    environment = @{}
    payloadJson = ($payload | ConvertTo-Json -Depth 100 -Compress)
    priority = "background"
    gamingAdmission = "reject"
    onPreempt = "fail"
    idempotent = $false
    maxAttempts = 1
    attachedClientPid = $PID
    cancelOnClientExit = $true
  }
  function Invoke-GpuqRpc([string]$Operation, $RpcPayload) {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(".", "gpuq-v1", [System.IO.Pipes.PipeDirection]::InOut)
    try {
      $pipe.Connect(5000)
      $reader = [System.IO.StreamReader]::new($pipe, [System.Text.Encoding]::UTF8, $false, 4096, $true)
      $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 4096, $true)
      $writer.AutoFlush = $true
      $rpc = @{ operation = $Operation; requestId = [Guid]::NewGuid().ToString("N"); payload = $RpcPayload } | ConvertTo-Json -Depth 100 -Compress
      $writer.WriteLine($rpc)
      $line = $reader.ReadLine()
      $response = $line | ConvertFrom-Json
      if (-not $response.ok) {
        if ($response.errorCode -eq "gaming_mode") { exit 75 }
        throw "gpuq RPC failed: $($response.errorCode)"
      }
      return $response.result
    } finally { $pipe.Dispose() }
  }
  $submitted = Invoke-GpuqRpc "submit" $spec
  $jobId = $submitted.id
  while ($true) {
    Start-Sleep -Milliseconds 750
    $job = Invoke-GpuqRpc "show" @{ id = $jobId }
    if ($job.state -in @("succeeded", "failed", "cancelled", "rejected")) { break }
  }
  if ($job.state -ne "succeeded") {
    if ($job.reasonCode -eq "gaming_mode") { exit 75 }
    throw "Qwen GPUQ job ended in state $($job.state): $($job.reasonCode)"
  }
  [System.IO.File]::ReadAllText($job.stdoutPath)
} finally {
  $requestText = $null
  $payload = $null
  $spec = $null
}
