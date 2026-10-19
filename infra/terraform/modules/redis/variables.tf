variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  type = list(string)
}

variable "node_type" {
  type    = string
  default = "cache.t4g.medium"
}

variable "num_cache_clusters" {
  description = "Nodes in the replication group (≥ 2 for Multi-AZ automatic failover)"
  type        = number
  default     = 2
}

variable "engine_version" {
  type    = string
  default = "7.1"
}

variable "snapshot_retention_limit" {
  type    = number
  default = 7
}

variable "kms_key_arn" {
  type = string
}

variable "secret_kms_key_arn" {
  description = "Key for the Secrets Manager secret that holds the auth token and URL"
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "tags" {
  type    = map(string)
  default = {}
}
