variable "name" {
  description = "Resource name prefix, e.g. pos-dev"
  type        = string
}

variable "cidr" {
  description = "VPC CIDR block"
  type        = string
}

variable "availability_zones" {
  description = "AZ names to spread subnets across (passed in so planning needs no AWS API access)"
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 3
    error_message = "Use two or three availability zones."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for the whole VPC (dev) instead of one per AZ (staging/prod)"
  type        = bool
  default     = false
}

variable "enable_interface_endpoints" {
  description = "Create interface endpoints for ECR, Logs, Secrets Manager, KMS and STS so tasks stay off the NAT path"
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  type    = number
  default = 30
}

variable "kms_key_arn" {
  description = "KMS key for the flow-log log group"
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
