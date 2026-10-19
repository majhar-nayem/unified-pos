variable "offline_plan" {
  description = "true = run plan with placeholder values and no AWS credentials (skips credential and account lookups)"
  type        = bool
  default     = false
}

variable "account_id" {
  type = string
}

variable "github_repository" {
  type = string
}

variable "github_create_oidc_provider" {
  description = "One OIDC provider per AWS account; true in the first stack of the account"
  type        = bool
  default     = true
}

variable "github_existing_oidc_provider_arn" {
  type    = string
  default = null
}

variable "alb_certificate_arn" {
  type = string
}

variable "cloudfront_prefix_list_id" {
  type = string
}

variable "origin_domain_name" {
  type    = string
  default = null
}

variable "domain_names" {
  type    = list(string)
  default = []
}

variable "cloudfront_certificate_arn" {
  type    = string
  default = null
}

variable "page_endpoints" {
  type = list(object({
    protocol = string
    endpoint = string
  }))
  default = []
}

variable "ticket_endpoints" {
  type = list(object({
    protocol = string
    endpoint = string
  }))
  default = []
}

variable "state_bucket_arn" {
  type    = string
  default = null
}

variable "image_tag" {
  type    = string
  default = "bootstrap"
}
