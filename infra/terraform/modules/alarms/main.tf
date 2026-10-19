locals {
  # Dimension tokens used by infra/alerts/alerts.json are resolved here.
  tokens = {
    "$alb"     = var.alb_arn_suffix
    "$cluster" = var.cluster_name
  }
  actions = {
    page   = [aws_sns_topic.page.arn]
    ticket = [aws_sns_topic.ticket.arn]
  }
  alerts      = { for a in var.app_alerts : a.id => a }
  composites  = { for c in var.app_composites : c.id => c }
  ecs_alarms  = { for s, min in var.services : s => min }
  redis_nodes = toset(var.redis_node_ids)
}

# --- notification topics ---------------------------------------------------------------------------

resource "aws_sns_topic" "page" {
  name              = "${var.name}-alerts-page"
  kms_master_key_id = var.kms_key_arn
  tags              = var.tags
}

resource "aws_sns_topic" "ticket" {
  name              = "${var.name}-alerts-ticket"
  kms_master_key_id = var.kms_key_arn
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "page" {
  count     = length(var.page_endpoints)
  topic_arn = aws_sns_topic.page.arn
  protocol  = var.page_endpoints[count.index].protocol
  endpoint  = var.page_endpoints[count.index].endpoint
}

resource "aws_sns_topic_subscription" "ticket" {
  count     = length(var.ticket_endpoints)
  topic_arn = aws_sns_topic.ticket.arn
  protocol  = var.ticket_endpoints[count.index].protocol
  endpoint  = var.ticket_endpoints[count.index].endpoint
}

# --- edge and API ----------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${var.name}-alb-elb-5xx"
  alarm_description   = "ALB itself is returning 5xx (not the targets). Runbook: docs/runbooks/on-call.md#alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions.page
  ok_actions          = local.actions.page
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_unhealthy_hosts" {
  for_each            = var.api_target_group_arn_suffixes
  alarm_name          = "${var.name}-api-${each.key}-unhealthy-hosts"
  alarm_description   = "Targets failing /v1/health. Runbook: docs/runbooks/on-call.md#unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = each.key == "blue" ? local.actions.page : local.actions.ticket
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_latency_p95" {
  alarm_name          = "${var.name}-api-latency-p95"
  alarm_description   = "Standard API request p95 above the §12.1 objective. Runbook: docs/runbooks/on-call.md#latency"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.latency_p95_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions.ticket
  ok_actions          = local.actions.ticket
  tags                = var.tags
}

# --- ECS ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  for_each            = local.ecs_alarms
  alarm_name          = "${var.name}-${each.key}-running-tasks-low"
  alarm_description   = "Fewer running tasks than the minimum. Runbook: docs/runbooks/on-call.md#ecs-tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = "${var.name}-${each.key}" }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions.page
  ok_actions          = local.actions.page
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each            = local.ecs_alarms
  alarm_name          = "${var.name}-${each.key}-cpu-high"
  alarm_description   = "Sustained CPU above 85 % (autoscaling is at its ceiling or lagging)."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = "${var.name}-${each.key}" }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 10
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions.ticket
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each            = local.ecs_alarms
  alarm_name          = "${var.name}-${each.key}-memory-high"
  alarm_description   = "Sustained memory above 85 % (OOM kills restart tasks)."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = "${var.name}-${each.key}" }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 10
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions.ticket
  tags                = var.tags
}

# --- Aurora ----------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "aurora" {
  for_each = {
    cpu = {
      metric  = "CPUUtilization", stat = "Average", op = "GreaterThanThreshold", threshold = 80,
      periods = 10, severity = "ticket", note = "Writer or reader CPU above 80 %"
    }
    freeable-memory = {
      metric  = "FreeableMemory", stat = "Minimum", op = "LessThanThreshold", threshold = 1073741824,
      periods = 5, severity = "page", note = "Less than 1 GiB freeable memory"
    }
    connections = {
      metric  = "DatabaseConnections", stat = "Maximum", op = "GreaterThanThreshold", threshold = var.aurora_max_connections_alarm,
      periods = 5, severity = "ticket", note = "Connection count approaching the pool ceiling"
    }
    replica-lag = {
      metric  = "AuroraReplicaLagMaximum", stat = "Maximum", op = "GreaterThanThreshold", threshold = 1000,
      periods = 5, severity = "ticket", note = "Reader lag above one second"
    }
    deadlocks = {
      metric  = "Deadlocks", stat = "Sum", op = "GreaterThanThreshold", threshold = 0,
      periods = 5, severity = "ticket", note = "Deadlocks detected"
    }
  }
  alarm_name          = "${var.name}-aurora-${each.key}"
  alarm_description   = "${each.value.note}. Runbook: docs/runbooks/on-call.md#database"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBClusterIdentifier = var.aurora_cluster_identifier }
  statistic           = each.value.stat
  period              = 60
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions[each.value.severity]
  tags                = var.tags
}

# --- Redis ----------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis" {
  for_each = {
    for pair in setproduct(local.redis_nodes, ["EngineCPUUtilization", "DatabaseMemoryUsagePercentage", "Evictions"]) :
    "${pair[0]}-${pair[1]}" => { node = pair[0], metric = pair[1] }
  }
  alarm_name          = "${var.name}-redis-${each.value.node}-${lower(each.value.metric)}"
  alarm_description   = "Redis ${each.value.metric} breach on ${each.value.node}. Streams must not be evicted. Runbook: docs/runbooks/on-call.md#redis"
  namespace           = "AWS/ElastiCache"
  metric_name         = each.value.metric
  dimensions          = { CacheClusterId = each.value.node }
  statistic           = each.value.metric == "Evictions" ? "Sum" : "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = each.value.metric == "Evictions" ? 0 : 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = each.value.metric == "Evictions" ? local.actions.page : local.actions.ticket
  tags                = var.tags
}

# --- application alerts generated from packages/observability --------------------------------------------

resource "aws_cloudwatch_metric_alarm" "app" {
  for_each            = local.alerts
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = "${each.value.description}${each.value.runbook == "" ? "" : " Runbook: ${each.value.runbook}"}"
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  treat_missing_data  = each.value.treat_missing_data
  alarm_actions       = each.value.notify ? local.actions[each.value.severity] : []
  ok_actions          = each.value.notify ? local.actions[each.value.severity] : []
  tags                = merge(var.tags, { Severity = each.value.severity })

  dynamic "metric_query" {
    for_each = each.value.metrics
    content {
      id          = metric_query.value.id
      expression  = metric_query.value.expression
      label       = metric_query.value.label
      return_data = metric_query.value.return_data || metric_query.value.expression != null

      dynamic "metric" {
        for_each = metric_query.value.metric == null ? [] : [metric_query.value.metric]
        content {
          namespace   = metric.value.namespace
          metric_name = metric.value.name
          stat        = metric.value.stat
          period      = metric.value.period
          dimensions  = { for k, v in metric.value.dimensions : k => lookup(local.tokens, v, v) }
        }
      }
    }
  }
}

resource "aws_cloudwatch_composite_alarm" "app" {
  for_each          = local.composites
  alarm_name        = "${var.name}-${each.key}"
  alarm_description = "${each.value.description}${each.value.runbook == "" ? "" : " Runbook: ${each.value.runbook}"}"
  alarm_rule        = join(" AND ", [for a in each.value.alarms : "ALARM(\"${aws_cloudwatch_metric_alarm.app[a].alarm_name}\")"])
  alarm_actions     = local.actions[each.value.severity]
  ok_actions        = local.actions[each.value.severity]
  tags              = merge(var.tags, { Severity = each.value.severity })
}
