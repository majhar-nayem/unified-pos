variable "name" {
  description = "Environment prefix, e.g. pos-dev"
  type        = string
}

variable "service_name" {
  description = "api, worker, payments, migrate, otel-collector"
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
  description = "Private subnets"
  type        = list(string)
}

variable "image" {
  description = "Container image. CI registers new task-definition revisions with the commit-tagged image; Terraform only seeds the first one."
  type        = string
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "min_count" {
  type    = number
  default = 2
}

variable "max_count" {
  type    = number
  default = 10
}

variable "enable_autoscaling" {
  type    = bool
  default = true
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "container_port" {
  description = "null for services that accept no inbound traffic (worker, migrate)"
  type        = number
  default     = null
}

variable "command" {
  description = "Override of the image command"
  type        = list(string)
  default     = null
}

variable "environment" {
  description = "Plain environment variables"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "ENV_NAME → Secrets Manager ARN, optionally with a JSON key selector (<arn>:key::)"
  type        = map(string)
  default     = {}
}

variable "secret_kms_key_arns" {
  description = "Keys that encrypt the referenced secrets (execution role needs kms:Decrypt)"
  type        = list(string)
  default     = []
}

variable "task_policy_json" {
  description = "Task role permissions (least privilege per service); null = none"
  type        = string
  default     = null
}

variable "kms_key_arn" {
  description = "Key for the log group"
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "health_check_command" {
  description = "Container health check, e.g. [\"CMD-SHELL\", \"wget -qO- http://localhost:3000/v1/health || exit 1\"]. Empty = none."
  type        = list(string)
  default     = []
}

variable "create_service" {
  description = "false = only the task definition, roles and security group (one-off tasks such as migrate)"
  type        = bool
  default     = true
}

variable "attach_task_policy" {
  description = "true when task_policy_json is set (must be known at plan time, unlike the policy document itself)"
  type        = bool
  default     = false
}

variable "enable_load_balancer" {
  description = "true when target_group_arn and alb_security_group_id are set (known at plan time)"
  type        = bool
  default     = false
}

variable "target_group_arn" {
  description = "Initial (blue) target group"
  type        = string
  default     = null
}

variable "alb_security_group_id" {
  type    = string
  default = null
}

variable "ingress_security_group_ids" {
  description = "Additional security groups allowed to reach container_port (api → payments)"
  type        = list(string)
  default     = []
}

variable "service_discovery_namespace_id" {
  type    = string
  default = null
}

variable "service_discovery_name" {
  type    = string
  default = null
}

variable "blue_green" {
  description = "Deploy through CodeDeploy (canary then full shift). Needs both target groups and the listener."
  type        = bool
  default     = false
}

variable "blue_target_group_name" {
  type    = string
  default = null
}

variable "green_target_group_name" {
  type    = string
  default = null
}

variable "listener_arn" {
  type    = string
  default = null
}

variable "canary_percentage" {
  type    = number
  default = 10
}

variable "canary_interval_minutes" {
  description = "Canary soak before the full shift (§10: 10 % for the 30 minute SLO watch)"
  type        = number
  default     = 30
}

variable "rollback_alarm_names" {
  description = "CloudWatch alarms that stop and roll back a deployment (SLO burn, 5xx)"
  type        = list(string)
  default     = []
}

variable "termination_wait_minutes" {
  description = "How long the old (blue) task set stays up after the shift for instant rollback"
  type        = number
  default     = 60
}

variable "tags" {
  type    = map(string)
  default = {}
}
