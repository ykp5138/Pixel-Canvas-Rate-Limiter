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

variable "instance_type" {
  description = "Free-tier-eligible, 2 vCPU / 1 GiB"
  type        = string
  default     = "t3.micro"
}

variable "app_image" {
  description = "App image pushed by CI"
  type        = string
  default     = "ghcr.io/ykp5138/pixel-canvas:latest"
}
