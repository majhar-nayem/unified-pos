locals {
  emf_log_group = "/pos/${var.environment}/app-metrics"

  # Traces, metrics and logs go to the observability backend. A short allow-list of operational
  # gauges is also written as CloudWatch EMF so infra/alerts can page without the backend.
  config = <<-YAML
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
    processors:
      memory_limiter:
        check_interval: 1s
        limit_percentage: 80
        spike_limit_percentage: 25
      resource:
        attributes:
          - key: deployment.environment
            value: ${var.environment}
            action: upsert
      attributes/redact:
        actions:
          - key: http.request.header.authorization
            action: delete
          - key: http.request.header.cookie
            action: delete
          - key: http.response.header.set-cookie
            action: delete
          - key: user.email
            action: delete
          - key: customer.email
            action: delete
          - key: customer.phone
            action: delete
      batch:
        timeout: 5s
        send_batch_size: 8192
    exporters:
      otlphttp/backend:
        endpoint: $${env:OTLP_ENDPOINT}
        headers:
          Authorization: $${env:OTLP_AUTH_HEADER}
      awsemf:
        region: ${data.aws_region.current.name}
        namespace: POS/App
        log_group_name: ${local.emf_log_group}
        dimension_rollup_option: NoDimensionRollup
        resource_to_telemetry_conversion:
          enabled: true
        metric_declarations:
          - dimensions: [["service.name"]]
            metric_name_selectors:
              - "pos.outbox.backlog"
              - "pos.outbox.oldest_age.seconds"
              - "pos.cross_tenant.attempts"
              - "pos.sync.lag.seconds"
              - "pos.payment.uncertain.count"
              - "pos.rls.context_missing"
              - "pos.audit.chain.verification_failures"
    service:
      extensions: [health_check]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resource, attributes/redact, batch]
          exporters: [otlphttp/backend]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, resource, attributes/redact, batch]
          exporters: [otlphttp/backend]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [otlphttp/backend, awsemf]
  YAML
}

data "aws_region" "current" {}

resource "aws_cloudwatch_log_group" "emf" {
  name              = local.emf_log_group
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "task" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.emf.arn}:*"]
  }
}

module "service" {
  source = "../ecs-service"

  name                           = var.name
  service_name                   = "otel-collector"
  cluster_arn                    = var.cluster_arn
  cluster_name                   = var.cluster_name
  vpc_id                         = var.vpc_id
  subnet_ids                     = var.subnet_ids
  image                          = var.image
  cpu                            = 512
  memory                         = 1024
  desired_count                  = var.desired_count
  min_count                      = var.desired_count
  max_count                      = var.desired_count * 3
  container_port                 = 4318
  ingress_security_group_ids     = var.client_security_group_ids
  health_check_command           = ["CMD", "/healthcheck"]
  service_discovery_namespace_id = var.namespace_id
  service_discovery_name         = "otel"
  kms_key_arn                    = var.kms_key_arn
  log_retention_days             = var.log_retention_days
  secret_kms_key_arns            = var.secret_kms_key_arns
  attach_task_policy             = true
  task_policy_json               = data.aws_iam_policy_document.task.json

  environment = {
    AOT_CONFIG_CONTENT = local.config
  }
  secrets = {
    OTLP_ENDPOINT    = "${var.backend_secret_arn}:endpoint::"
    OTLP_AUTH_HEADER = "${var.backend_secret_arn}:auth_header::"
  }
  tags = var.tags
}
