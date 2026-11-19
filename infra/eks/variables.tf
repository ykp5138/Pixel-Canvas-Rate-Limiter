variable "region" {
  description = "Account home region (Free plan blocks other regions)"
  type        = string
  default     = "us-east-2"
}

variable "profile" {
  description = "AWS CLI profile"
  type        = string
  default     = "pixel"
}

variable "cluster_name" {
  type    = string
  default = "pixel-canvas"
}

variable "kubernetes_version" {
  type    = string
  default = "1.37"
}

variable "node_instance_type" {
  description = "Free-tier-eligible, 2 vCPU / 4 GiB"
  type        = string
  default     = "c7i-flex.large"
}

variable "node_count" {
  type    = number
  default = 2
}
