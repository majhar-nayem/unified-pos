variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Isolated subnets"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach port 5432 (api, worker, payments, migration runner)"
  type        = list(string)
}

variable "engine_version" {
  type    = string
  default = "16.6"
}

variable "instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "reader_count" {
  description = "Aurora replicas (≥ 1 for multi-AZ failover)"
  type        = number
  default     = 1
}

variable "backup_retention_days" {
  description = "PITR window"
  type        = number
  default     = 7
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "kms_key_arn" {
  description = "Storage, Performance Insights and master-secret encryption"
  type        = string
}

variable "database_name" {
  type    = string
  default = "pos"
}

variable "master_username" {
  type    = string
  default = "pos_admin"
}

variable "log_min_duration_ms" {
  type    = number
  default = 500
}

variable "tags" {
  type    = map(string)
  default = {}
}
