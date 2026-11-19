output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${aws_eks_cluster.this.name} --region ${var.region} --profile ${var.profile} --alias eks"
}
