param(
  [string]$Scope = 'main'
)
. (Join-Path $PSScriptRoot "tree-config.ps1")
Assert-TreeScope $Scope

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$endpoint = 'http://127.0.0.1:9226'
$planFile = Join-Path ([IO.Path]::GetTempPath()) ("family-history-browser-batch-{0}.json" -f [Guid]::NewGuid().ToString('N'))
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
$validationTimer = [Diagnostics.Stopwatch]::StartNew()

function Assert-ExactFields($Value, [string[]]$Allowed, [string]$Label) {
  foreach ($property in $Value.PSObject.Properties.Name) {
    if ($Allowed -notcontains $property) { throw "Unknown $Label field: $property." }
  }
}

function Assert-NoSensitiveFields($Value, [string]$Trail = 'plan') {
  if ($null -eq $Value -or $Value -is [string] -or $Value.GetType().IsPrimitive) { return }
  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [Management.Automation.PSCustomObject]) {
    $index = 0
    foreach ($item in $Value) { Assert-NoSensitiveFields $item "$Trail[$index]"; $index += 1 }
    return
  }
  foreach ($property in $Value.PSObject.Properties) {
    if ($property.Name -match '(?i)password|passphrase|pin|cvv|cvc|card|cookie|authorization|secret|token|credential|email|phone|address') {
      throw "Sensitive field is forbidden in a browser batch plan: $Trail.$($property.Name)."
    }
    Assert-NoSensitiveFields $property.Value "$Trail.$($property.Name)"
  }
}

function Assert-BatchPlan($Plan) {
  Assert-NoSensitiveFields $Plan
  Assert-ExactFields $Plan @('schemaVersion','provider','affinitySlot','research','steps') 'plan'
  if ($Plan.schemaVersion -ne 1) { throw 'schemaVersion must be exactly 1.' }
  if (@('ancestry','antenati','findmypast','familysearch','pcusa','ava','archion') -notcontains $Plan.provider) { throw 'provider must be ancestry, antenati, findmypast, familysearch, pcusa, ava, or archion.' }
  if ([string]$Plan.affinitySlot -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { throw 'affinitySlot is invalid.' }
  Assert-ExactFields $Plan.research @('questionId','actionId','coverage','scope') 'research'
  if ([string]$Plan.research.questionId -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$' -or [string]$Plan.research.actionId -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$') { throw 'Canonical research ids are invalid.' }
  if ([string]::IsNullOrWhiteSpace([string]$Plan.research.coverage) -or ([string]$Plan.research.coverage).Length -gt 1000) { throw 'research.coverage is invalid.' }
  $planScope = if ($null -eq $Plan.research.scope -or [string]::IsNullOrWhiteSpace([string]$Plan.research.scope)) { 'main' } else { [string]$Plan.research.scope }
  if ((Get-TreeScopes) -notcontains $planScope) { throw "research.scope must be one of: $((Get-TreeScopes) -join ', ')." }
  if ($planScope -ne $Scope) { throw "Batch plan scope $planScope does not match wrapper scope $Scope." }
  if ($null -eq $Plan.steps -or $Plan.steps.Count -lt 1 -or $Plan.steps.Count -gt 25) { throw 'steps must contain 1 through 25 operations.' }
  $operations = @{
    ancestry = @('search-results','public-tree-results','public-tree-person','record-facts')
    antenati = @('registry-context')
    findmypast = @('findmypast-row','findmypast-transcript','findmypast-newspaper-results')
    familysearch = @('fulltext-search','record-facts','page-links','page-context','viewer-metadata')
    pcusa = @('catalog-results','catalog-detail','catalog-marc','digital-context')
    ava = @('document-search','document-image-context')
    archion = @('catalog-results')
  }
  $hosts = @{
    ancestry = '(^|\.)(ancestry\.(com|co\.uk))$'
    antenati = '(^|\.)antenati\.cultura\.gov\.it$'
    findmypast = '(^|\.)(findmypast\.(com|co\.uk))$'
    familysearch = '(^|\.)familysearch\.org$'
    pcusa = '^(catalog|digital)\.history\.pcusa\.org$'
    ava = '^ava\.fidlar\.com$'
    archion = '^www\.archion\.de$'
  }
  $ids = @{}
  foreach ($step in $Plan.steps) {
    Assert-ExactFields $step @('id','operation','url','matchTerms','returnLimit','openRowTerms','openRowOrdinal') 'step'
    if ([string]$step.id -notmatch '^[a-z0-9][a-z0-9._-]{0,79}$' -or $ids.ContainsKey([string]$step.id)) { throw "Invalid or duplicate step id: $($step.id)." }
    $ids[[string]$step.id] = $true
    if ($operations[$Plan.provider] -notcontains [string]$step.operation) { throw "Operation is not read-only for $($Plan.provider): $($step.operation)." }
    try { $uri = [Uri]([string]$step.url) } catch { throw "Invalid step URL: $($step.url)." }
    if ($uri.Scheme -ne 'https' -or $uri.IdnHost -notmatch $hosts[$Plan.provider] -or $uri.UserInfo) { throw "URL is not an allowed HTTPS $($Plan.provider) route." }
    if ($Plan.provider -eq 'familysearch' -and $step.operation -eq 'viewer-metadata') {
      if ($uri.IdnHost -ne 'www.familysearch.org' -or -not $uri.IsDefaultPort -or $uri.Fragment -or $uri.AbsolutePath -notmatch '^/ark:/61903/3:1:[A-Z0-9-]+/?$') { throw 'FamilySearch viewer metadata requires one exact image ARK without a fragment.' }
      foreach ($part in $uri.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
        $key = [Uri]::UnescapeDataString(($part -split '=', 2)[0])
        if (@('wc','owc','i','cc','groupId','lang') -cnotcontains $key) { throw 'FamilySearch viewer metadata permits only browse-context query parameters.' }
      }
    }
    if ($Plan.provider -eq 'findmypast' -and $step.operation -eq 'findmypast-newspaper-results' -and $uri.AbsolutePath -ne '/search-newspapers/results') { throw 'Findmypast newspaper results require the exact /search-newspapers/results route.' }
    if ($Plan.provider -eq 'ancestry' -and $step.operation -eq 'public-tree-results' -and $uri.AbsolutePath -notmatch '^/search/collections/1030/?$') { throw 'Public-tree results are limited to the Ancestry Public Member Trees collection.' }
    if ($Plan.provider -eq 'ancestry' -and $step.operation -eq 'public-tree-person' -and $uri.AbsolutePath -notmatch '^/family-tree/person/tree/\d+/person/-?\d+/facts/?$') { throw 'Public-tree person inspection requires one exact Ancestry person facts route.' }
    if ($Plan.provider -eq 'antenati' -and $step.operation -eq 'registry-context' -and $uri.AbsolutePath -notmatch '^/ark:/12657/an_ua\d+/?$') { throw 'Antenati registry context requires one exact register ARK route.' }
    if ($Plan.provider -eq 'pcusa' -and $step.operation -eq 'catalog-results' -and ($uri.IdnHost -ne 'catalog.history.pcusa.org' -or $uri.AbsolutePath -ne '/cgi-bin/koha/opac-search.pl')) { throw 'PHS catalog results require the exact Koha search route.' }
    if ($Plan.provider -eq 'pcusa' -and $step.operation -eq 'catalog-detail' -and ($uri.IdnHost -ne 'catalog.history.pcusa.org' -or $uri.AbsolutePath -ne '/cgi-bin/koha/opac-detail.pl' -or [string]$step.url -notmatch '[?&]biblionumber=\d+(?:&|$)')) { throw 'PHS catalog detail requires one exact numeric biblionumber route.' }
    if ($Plan.provider -eq 'pcusa' -and $step.operation -eq 'catalog-marc' -and ($uri.IdnHost -ne 'catalog.history.pcusa.org' -or $uri.AbsolutePath -ne '/cgi-bin/koha/opac-MARCdetail.pl' -or [string]$step.url -notmatch '[?&]biblionumber=\d+(?:&|$)')) { throw 'PHS catalog MARC detail requires one exact numeric biblionumber route.' }
    if ($Plan.provider -eq 'pcusa' -and $step.operation -eq 'digital-context' -and ($uri.IdnHost -ne 'digital.history.pcusa.org' -or $uri.AbsolutePath -notmatch '^/(?:$|islandora/(?:search|object)(?:/|$))')) { throw 'PHS digital context requires the digital root, search, or exact object route.' }
    if ($Plan.provider -eq 'ava' -and @('document-search','document-image-context') -contains [string]$step.operation -and ($uri.IdnHost -ne 'ava.fidlar.com' -or $uri.AbsolutePath -ne '/OHFairfield/AvaWeb/' -or $uri.Query -or $uri.Fragment -notmatch '^#/search\?docname=(?:GE|GR)1801-99-[A-Z]{3}-[A-Z]{3}$')) { throw 'AVA document search requires one exact Fairfield County grantor or grantee index document route.' }
    if ($Plan.provider -eq 'archion' -and ($uri.IdnHost -ne 'www.archion.de' -or -not $uri.IsDefaultPort -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath.TrimEnd('/') -notmatch '^/de/alle-archive/niedersachsen/landeskirchliches-archiv-der-evangelisch-lutherischen-landeskirche-in-braunschweig/braunschweig-(?:kreuzkloster|st-andreas|dom-st-blasius|st-katharinen|st-magni|st-martini|st-michaelis|st-petri|st-ulrici-bruedern)$')) { throw 'Archion catalogue input requires one exact canonical Braunschweig parish route.' }
    if ($null -ne $step.returnLimit -and ([int]$step.returnLimit -lt 1 -or [int]$step.returnLimit -gt 100)) { throw 'returnLimit must be from 1 through 100.' }
    if ($null -ne $step.matchTerms) {
      if ($step.matchTerms.Count -gt 12) { throw 'matchTerms may contain at most 12 terms.' }
      foreach ($term in @($step.matchTerms)) { if ([string]::IsNullOrWhiteSpace([string]$term) -or ([string]$term).Length -gt 160) { throw 'A match term is invalid.' } }
    }
    if ($null -ne $step.openRowTerms) {
      if ($Plan.provider -ne 'findmypast' -or [string]$step.operation -ne 'findmypast-row') { throw 'openRowTerms is only valid for a findmypast-row step.' }
      if (@($step.openRowTerms).Count -lt 2 -or @($step.openRowTerms).Count -gt 6) { throw 'openRowTerms must contain 2 through 6 terms.' }
      foreach ($term in @($step.openRowTerms)) { if ([string]::IsNullOrWhiteSpace([string]$term) -or ([string]$term).Length -gt 160) { throw 'An openRowTerms term is invalid.' } }
    }
    if ($null -ne $step.openRowOrdinal) {
      if ($null -eq $step.openRowTerms) { throw 'openRowOrdinal requires openRowTerms.' }
      $ordinal = 0
      if (-not [int]::TryParse([string]$step.openRowOrdinal, [ref]$ordinal) -or $ordinal -lt 1 -or $ordinal -gt 5) { throw 'openRowOrdinal must be an integer from 1 through 5.' }
    }
  }
  $questionFile = Join-Path $ProjectRoot "evidence\research\questions\$($Plan.research.questionId).json"
  if (-not (Test-Path -LiteralPath $questionFile)) { throw "Canonical research question does not exist: $($Plan.research.questionId)." }
  $question = Get-Content -LiteralPath $questionFile -Raw | ConvertFrom-Json
  $canonicalAction = @($question.actions | Where-Object { $_.id -eq $Plan.research.actionId })
  if ($question.id -ne $Plan.research.questionId -or $canonicalAction.Count -ne 1) { throw "Canonical action does not exist: $($Plan.research.actionId)." }
  $questionScope = if ($null -eq $question.researchScope -or [string]::IsNullOrWhiteSpace([string]$question.researchScope)) { 'main' } else { [string]$question.researchScope }
  if ($questionScope -ne $planScope) { throw "Canonical question belongs to $questionScope, not $planScope." }
  if ($Plan.provider -eq 'archion') { Assert-ArchionCatalogPlan $Plan $question $canonicalAction[0] }
}

function Assert-ArchionCatalogPlan($Plan, $Question, $Action) {
  # The tree's one Archion catalogue batch (tree/archion-catalog.json).
  $catalogFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'tree\archion-catalog.json'
  if (-not (Test-Path -LiteralPath $catalogFile)) { throw 'No Archion catalogue batch is configured for this tree (tree/archion-catalog.json).' }
  $catalog = Get-Content -LiteralPath $catalogFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $questionId = [string]$catalog.questionId
  $actionId = [string]$catalog.actionId
  $targetId = [string]$catalog.targetId
  $routeId = [string]$catalog.routeId
  $authorizationTargetId = [string]$catalog.authorizationTargetId
  $archiveUrl = [string]$catalog.archiveUrl
  $expected = [ordered]@{}
  foreach ($parish in $catalog.parishes) { $expected[[string]$parish[0]] = "$archiveUrl/$([string]$parish[2])" }
  if ($Plan.research.questionId -ne $questionId -or $Plan.research.actionId -ne $actionId -or $Plan.research.scope -ne 'main' -or $Scope -ne 'main') { throw 'Archion catalogue batches require the exact main-scope question and action.' }
  if ($Question.id -ne $questionId -or $Question.lifecycle -ne 'active' -or $Action.id -ne $actionId -or $Action.status -ne 'ready' -or $Action.acquisitionTargetId -ne $targetId) { throw 'The canonical Archion catalogue action is missing, stale, gated, or completed.' }
  if ($Plan.steps.Count -ne $expected.Count) { throw "Archion catalogue discovery requires exactly $($expected.Count) parish steps." }
  foreach ($step in $Plan.steps) {
    if (-not $expected.Contains([string]$step.id) -or [string]$step.operation -ne 'catalog-results' -or ([Uri]([string]$step.url)).AbsoluteUri.TrimEnd('/') -ne ([string]$expected[[string]$step.id]).TrimEnd('/')) { throw "Archion step $($step.id) is not its exact canonical parish route." }
  }
  if (@($Plan.steps.id | Sort-Object -Unique).Count -ne $expected.Count) { throw 'Archion parish steps must be unique.' }

  $targetFile = Join-Path $ProjectRoot "evidence\acquisition\targets\$targetId.json"
  $requestFile = Join-Path $ProjectRoot "evidence\acquisition\requests\$authorizationTargetId.json"
  $authorizationTargetFile = Join-Path $ProjectRoot "evidence\acquisition\targets\$authorizationTargetId.json"
  foreach ($file in @($targetFile,$requestFile,$authorizationTargetFile)) { if (-not (Test-Path -LiteralPath $file)) { throw "Required canonical Archion file is missing: $file" } }
  $target = Get-Content -LiteralPath $targetFile -Raw | ConvertFrom-Json
  $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
  $authorizationTarget = Get-Content -LiteralPath $authorizationTargetFile -Raw | ConvertFrom-Json
  $route = @($target.routes | Where-Object { $_.id -eq $routeId })
  if ($route.Count -ne 1) { throw 'The exact canonical Archion catalogue route is missing.' }
  $route = $route[0]
  $candidateSet = @($route.candidateUrls | ForEach-Object { ([Uri]([string]$_)).AbsoluteUri.TrimEnd('/') } | Sort-Object -Unique)
  $expectedSet = @($expected.Values | ForEach-Object { ([string]$_).TrimEnd('/') } | Sort-Object -Unique)
  if (($candidateSet -join "`n") -ne ($expectedSet -join "`n")) { throw 'The canonical Archion route must retain all nine exact parish candidates.' }
  if ($target.id -ne $targetId -or $target.sourceId -ne $targetId -or $target.provider -ne 'Archion' -or @($target.questionIds) -notcontains $questionId -or $route.targetId -ne $targetId -or $route.sourceQueue -ne 'archion-access' -or $route.provider -ne 'Archion' -or $route.route -ne 'paid-provider-subscription' -or $route.status -ne 'subscription-first' -or ([Uri]([string]$route.sourceUrl)).AbsoluteUri.TrimEnd('/') -ne $archiveUrl) { throw 'The exact canonical Archion target and subscription-first archive route are required.' }
  $entitlement = $route.accessEntitlement
  $event = @($request.events | Where-Object { $_.id -eq $entitlement.accessConfirmedEventId -and $_.type -eq 'access-confirmed' })
  $requestItem = @($request.items | Where-Object { $_.targetId -eq $authorizationTargetId })
  [array]$authorizationRoute = if ($requestItem.Count -eq 1) { $authorizationTarget.routes | Where-Object { $_.id -eq $requestItem[0].routeId } } else { @() }
  $entitlementIssues = @()
  if ($entitlement.schemaVersion -ne 1 -or $entitlement.authorizationState -ne 'authorized') { $entitlementIssues += 'authorization-state' }
  if ($entitlement.authorizationTargetId -ne $authorizationTargetId -or $entitlement.requestId -ne $authorizationTargetId) { $entitlementIssues += 'authorization-target' }
  if ($event.Count -ne 1 -or $event[0].at -ne $entitlement.confirmedAt) { $entitlementIssues += 'access-confirmed-event' }
  if ([DateTimeOffset]::Parse([string]$entitlement.expiresAt) -le [DateTimeOffset]::UtcNow) { $entitlementIssues += 'expiry' }
  if ([string]$route.serviceOption -notlike "*$authorizationTargetId*") { $entitlementIssues += 'reuse-service-option' }
  if ($request.id -ne $authorizationTargetId -or $request.kind -ne 'paid-order' -or $request.provider -ne 'Archion') { $entitlementIssues += 'paid-order-request' }
  if ($request.guard.requiredPhrase -ne "PAY $authorizationTargetId" -or $request.guard.costMode -ne 'maximum' -or $request.guard.currency -ne 'EUR' -or [decimal]$request.guard.maxAmount -ne [decimal]19.9) { $entitlementIssues += 'cost-guard' }
  if ($requestItem.Count -ne 1) { $entitlementIssues += 'request-item' }
  if ($authorizationTarget.id -ne $authorizationTargetId -or $authorizationTarget.provider -ne 'Archion') { $entitlementIssues += 'authorization-target-record' }
  if ($authorizationRoute.Count -ne 1) { $entitlementIssues += 'authorization-route-count' }
  elseif ($authorizationRoute[0].targetId -ne $authorizationTargetId) { $entitlementIssues += 'authorization-route-target' }
  elseif ($authorizationRoute[0].provider -ne 'Archion') { $entitlementIssues += 'authorization-route-provider' }
  elseif ($authorizationRoute[0].sourceQueue -ne 'archion-access') { $entitlementIssues += 'authorization-route-queue' }
  elseif ($authorizationRoute[0].route -ne 'paid-provider-subscription') { $entitlementIssues += 'authorization-route-type' }
  elseif (-not (@('acquired','published') -contains $authorizationRoute[0].status)) { $entitlementIssues += 'authorization-route-status' }
  if ($entitlementIssues.Count) { throw "The Archion catalogue route has no valid active reusable entitlement: $($entitlementIssues -join ', ')." }
}

try {
  $planJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($planJson)) { throw 'Provide exactly one JSON batch plan on stdin.' }
  if ([Text.Encoding]::UTF8.GetByteCount($planJson) -gt 1048576) { throw 'The JSON batch plan exceeds the 1 MiB safety limit.' }
  $plan = $planJson | ConvertFrom-Json
  $ProjectRoot = Split-Path -Parent $ScriptDir
  Assert-BatchPlan $plan
  [IO.File]::WriteAllText($planFile, $planJson, [Text.UTF8Encoding]::new($false))
  $validationTimer.Stop()
  $env:RESEARCH_BATCH_VALIDATION_MS = [string]$validationTimer.ElapsedMilliseconds

  $endpointTimer = [Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
  if (-not $ready) {
    & (Join-Path $ScriptDir 'subscription-cdp-windows.ps1') -Mode start
    if ($LASTEXITCODE -ne 0) { throw 'The shared Windows Chrome profile could not be started.' }
    for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
      Start-Sleep -Milliseconds 250
      try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
    }
  }
  if (-not $ready) { throw 'The shared Windows Chrome profile exposed no localhost CDP endpoint.' }
  $endpointTimer.Stop()
  $env:RESEARCH_BATCH_ENDPOINT_READY_MS = [string]$endpointTimer.ElapsedMilliseconds

  $mutexTimer = [Diagnostics.Stopwatch]::StartNew()
  try { $browserMutexAcquired = $browserMutex.WaitOne(900000) }
  catch [System.Threading.AbandonedMutexException] { $browserMutexAcquired = $true }
  if (-not $browserMutexAcquired) { throw 'The one shared Windows Chrome window is busy; retry after the current transaction.' }
  $mutexTimer.Stop()
  $env:RESEARCH_BATCH_MUTEX_WAIT_MS = [string]$mutexTimer.ElapsedMilliseconds

  & node.exe (Join-Path $ScriptDir 'research-browser-batch.mjs') '--plan-file' $planFile
  if ($LASTEXITCODE -ne 0) { throw 'Read-only research browser batch failed.' }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
  Remove-Item -LiteralPath $planFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:RESEARCH_BATCH_VALIDATION_MS -ErrorAction SilentlyContinue
  Remove-Item Env:RESEARCH_BATCH_ENDPOINT_READY_MS -ErrorAction SilentlyContinue
  Remove-Item Env:RESEARCH_BATCH_MUTEX_WAIT_MS -ErrorAction SilentlyContinue
}
