# Deletes everything up.ps1 created, then checks for anything still billing.
#   .\infra\eks\down.ps1      (from the repo root)

$ErrorActionPreference = "Stop"

function Check($what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# The load balancer and Redis's EBS volume are created by Kubernetes, not Terraform,
# so they must be deleted through Kubernetes while the cluster still exists.
Write-Host "== Deleting app namespace (removes load balancer + EBS volume)" -ForegroundColor Cyan
kubectl --context eks delete namespace pixel-canvas --ignore-not-found --timeout=600s
if ($LASTEXITCODE -ne 0) { Write-Host "namespace delete failed; continuing, check leftovers below" -ForegroundColor Red }

Write-Host "== Destroying cluster (about 10-15 min)" -ForegroundColor Cyan
terraform -chdir="$PSScriptRoot" destroy; Check "terraform destroy"

cmd /c "kubectl config delete-context eks >nul 2>&1"

Write-Host "== Leftover check (each list should be empty)" -ForegroundColor Cyan
$p = @("--profile", "pixel", "--region", "us-east-2", "--output", "text")
Write-Host "EKS clusters:";        aws eks list-clusters @p --query "clusters"
Write-Host "Load balancers:";      aws elbv2 describe-load-balancers @p --query "LoadBalancers[].LoadBalancerName"
Write-Host "Unattached volumes:";  aws ec2 describe-volumes @p --filters Name=status,Values=available --query "Volumes[].VolumeId"
Write-Host "EKS node servers:";    aws ec2 describe-instances @p --filters Name=tag-key,Values=eks:cluster-name Name=instance-state-name,Values=pending,running,stopping,stopped --query "Reservations[].Instances[].InstanceId"
Write-Host ""
Write-Host "If every list above is empty, nothing from the EKS test is still billing." -ForegroundColor Green
Write-Host "(The EC2 live server from infra/ec2 is separate and stays up.)"
