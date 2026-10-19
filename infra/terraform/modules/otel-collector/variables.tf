variable "name" {
  type = string
}

variable "environment" {
  description = "Deployment environment label added to every signal (dev, staging, prod-au)"
  type        = string
}

variable "cluster_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "namespace_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "secret_kms_key_arns" {
  type    = list(string)
  default = []
}

variable "client_security_group_ids" {
  description = "api, worker and payments task security groups that may send OTLP/HTTP (4318)"
  type        = list(string)
}

variable "backend_secret_arn" {
  description = "Secret with JSON keys endpoint (OTLP/HTTP base URL of Grafana Cloud or Datadog) and auth_header"
  type        = string
}

variable "image" {
  description = "ADOT collector image. Pin to a verified tag; Renovate keeps it current."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.1"
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
