# Creates the EKS cluster and deploys the app. Billing starts here: run down.ps1 the same day.
#   .\infra\eks\up.ps1      (from the repo root)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\..\.."

function Check($what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Write-Host "== Creating cluster (about 15-20 min)" -ForegroundColor Cyan
terraform -chdir="$PSScriptRoot" init -input=false; Check "terraform init"
terraform -chdir="$PSScriptRoot" apply; Check "terraform apply"

Write-Host "== Adding kubectl context 'eks'" -ForegroundColor Cyan
aws eks update-kubeconfig --name pixel-canvas --region us-east-2 --profile pixel --alias eks; Check "update-kubeconfig"
# Keep kind as the default context so nothing else accidentally targets EKS
kubectl config use-context kind-pixel-canvas | Out-Null

Write-Host "== Deploying the app" -ForegroundColor Cyan
$manifest = Join-Path $env:TEMP "pixel-canvas-eks.yaml"
# cmd redirect keeps the file's bytes intact (PowerShell 5.1 pipes re-encode text)
cmd /c "kubectl kustomize --load-restrictor LoadRestrictionsNone `"$repo\infra\eks\k8s`" > `"$manifest`""; Check "kustomize"
kubectl --context eks apply -f $manifest; Check "kubectl apply"
kubectl --context eks -n pixel-canvas rollout status statefulset/redis --timeout=300s; Check "redis rollout"
kubectl --context eks -n pixel-canvas rollout status deployment/app --timeout=300s; Check "app rollout"

Write-Host "== Waiting for the load balancer" -ForegroundColor Cyan
$lb = ""
for ($i = 0; $i -lt 60 -and -not $lb; $i++) {
  $lb = kubectl --context eks -n pixel-canvas get svc app -o jsonpath="{.status.loadBalancer.ingress[0].hostname}"
  if (-not $lb) { Start-Sleep 5 }
}
if (-not $lb) { throw "load balancer never got a hostname" }

Write-Host ""
Write-Host "Up. App: http://$lb  (DNS can take 2-3 min to start resolving)" -ForegroundColor Green
Write-Host "Delete everything with: .\infra\eks\down.ps1" -ForegroundColor Yellow
