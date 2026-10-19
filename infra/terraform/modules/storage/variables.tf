variable "name" {
  type = string
}

variable "account_id" {
  type = string
}

variable "kms_key_arn" {
  description = "Key for receipts/exports/anchors"
  type        = string
}

variable "audit_anchor_retention_years" {
  description = "Object Lock COMPLIANCE retention for audit chain anchors"
  type        = number
  default     = 7
}

variable "receipts_expiration_days" {
  description = "Receipts lifecycle expiry (0 = keep forever)"
  type        = number
  default     = 0
}

variable "exports_expiration_days" {
  type    = number
  default = 90
}

variable "elb_account_id" {
  description = "ELB log-delivery account for the region (ap-southeast-2 = 783225319266)"
  type        = string
  default     = "783225319266"
}

variable "force_destroy" {
  description = "Allow destroying non-empty buckets (dev only; never true for anchors)"
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
