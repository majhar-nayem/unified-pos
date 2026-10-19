variable "name" {
  type = string
}

variable "kms_key_arn" {
  description = "Key for the SNS topics"
  type        = string
}

variable "page_endpoints" {
  description = "Page subscriptions, e.g. [{ protocol = \"https\", endpoint = \"<PagerDuty CloudWatch integration URL>\" }]"
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

variable "alb_arn_suffix" {
  type = string
}

variable "api_target_group_arn_suffixes" {
  description = "blue/green → target group ARN suffix"
  type        = map(string)
}

variable "cluster_name" {
  type = string
}

variable "services" {
  description = "ECS service name → minimum healthy running tasks"
  type        = map(number)
}

variable "aurora_cluster_identifier" {
  type = string
}

variable "aurora_max_connections_alarm" {
  type    = number
  default = 400
}

variable "redis_node_ids" {
  description = "ElastiCache member cluster ids (<replication-group>-001, …)"
  type        = list(string)
}

variable "latency_p95_seconds" {
  description = "Standard API request SLO (§12.1: p95 < 300 ms)"
  type        = number
  default     = 0.3
}

variable "app_alerts" {
  description = "Application alert definitions generated from packages/observability (infra/alerts/alerts.json)"
  type = list(object({
    id                  = string
    description         = string
    severity            = string
    runbook             = optional(string, "")
    comparison          = string
    threshold           = number
    period              = number
    evaluation_periods  = number
    datapoints_to_alarm = optional(number)
    treat_missing_data  = optional(string, "notBreaching")
    notify              = optional(bool, true)
    metrics = list(object({
      id          = string
      expression  = optional(string)
      label       = optional(string)
      return_data = optional(bool, false)
      metric = optional(object({
        namespace  = string
        name       = string
        stat       = string
        period     = number
        dimensions = optional(map(string), {})
      }))
    }))
  }))
  default = []
}

variable "app_composites" {
  description = "Multi-window burn-rate alarms: page only when every member alarm fires"
  type = list(object({
    id          = string
    description = string
    severity    = string
    runbook     = optional(string, "")
    alarms      = list(string)
  }))
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
