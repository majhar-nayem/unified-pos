variable "name" {
  type = string
}

variable "account_id" {
  type = string
}

variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the roles"
  type        = string
}

variable "create_provider" {
  description = "One OIDC provider per AWS account: true in the first stack of an account, false after (then set existing_provider_arn)"
  type        = bool
  default     = true
}

variable "existing_provider_arn" {
  type    = string
  default = null
}

variable "github_environment" {
  description = "GitHub Environment whose jobs may deploy here (dev, staging, prod-au). Approvals and wait timers are configured on the Environment."
  type        = string
}

variable "ecr_repository_arns" {
  type = list(string)
}

variable "cluster_name" {
  type = string
}

variable "pass_role_arns" {
  description = "Task and execution roles ECS may be given when registering task definitions"
  type        = list(string)
}

variable "state_bucket_arn" {
  description = "Terraform state bucket (plan role reads it)"
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
