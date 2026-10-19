variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_logs_bucket" {
  type = string
}

variable "certificate_arn" {
  description = "ACM certificate (ap-southeast-2) for the ALB HTTPS listener"
  type        = string
}

variable "cloudfront_prefix_list_id" {
  description = "AWS-managed CloudFront origin-facing prefix list for the region (aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing). It counts as 55 rules against the security-group rule quota: request a quota increase."
  type        = string
}

variable "origin_domain_name" {
  description = "DNS name covered by the ALB certificate that resolves to the ALB. CloudFront validates the origin certificate against it. null = use the ALB DNS name (only valid if the certificate covers it)."
  type        = string
  default     = null
}

variable "domain_names" {
  description = "Viewer aliases for CloudFront"
  type        = list(string)
  default     = []
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate in us-east-1 for domain_names; null = default *.cloudfront.net certificate"
  type        = string
  default     = null
}

variable "api_port" {
  type    = number
  default = 3000
}

variable "payments_port" {
  type    = number
  default = 3100
}

variable "health_check_path" {
  type    = string
  default = "/v1/health"
}

variable "payments_health_check_path" {
  type    = string
  default = "/v1/health"
}

variable "webhook_path_patterns" {
  description = "Provider webhooks are routed to the payments service"
  type        = list(string)
  default     = ["/v1/webhooks/*"]
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "waf_rate_limit" {
  description = "Requests per 5 minutes per source IP before blocking"
  type        = number
  default     = 3000
}

variable "price_class" {
  type    = string
  default = "PriceClass_All"
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
