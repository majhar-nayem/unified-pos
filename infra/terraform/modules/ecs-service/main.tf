data "aws_region" "current" {}

locals {
  full_name = "${var.name}-${var.service_name}"
  has_port  = var.container_port != null
  secret_arns = distinct([
    for v in values(var.secrets) :
    regex("^(arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:[^:]+)", v)[0]
  ])
  health_check = length(var.health_check_command) == 0 ? null : {
    command     = var.health_check_command
    interval    = 15
    timeout     = 5
    retries     = 3
    startPeriod = 30
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}/${var.service_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

# --- network ---------------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = local.full_name
  description = "${local.full_name} tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = local.full_name })
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.this.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound to data tier, endpoints and providers (NAT)"
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  count                        = local.has_port && var.enable_load_balancer ? 1 : 0
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.alb_security_group_id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "peers" {
  count                        = local.has_port ? length(var.ingress_security_group_ids) : 0
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.ingress_security_group_ids[count.index]
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

# --- IAM: execution role (pull image, write logs, read this service's secrets only) -----------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.full_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.secret_arns
  }
  dynamic "statement" {
    for_each = length(var.secret_kms_key_arns) > 0 ? [1] : []
    content {
      actions   = ["kms:Decrypt"]
      resources = var.secret_kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(var.secrets) > 0 ? 1 : 0
  name   = "read-own-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# --- IAM: task role (what the application code may do) --------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${local.full_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "task" {
  count  = var.attach_task_policy ? 1 : 0
  name   = "service"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

# --- task definition -------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = local.full_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  # The root filesystem is read-only; /tmp is the only writable path.
  volume {
    name = "tmp"
  }

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    merge(
      {
        name                   = var.service_name
        image                  = var.image
        essential              = true
        readonlyRootFilesystem = true
        stopTimeout            = 30
        linuxParameters        = { initProcessEnabled = true }
        mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
        environment            = [for k, v in var.environment : { name = k, value = v }]
        secrets                = [for k, v in var.secrets : { name = k, valueFrom = v }]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.this.name
            "awslogs-region"        = data.aws_region.current.name
            "awslogs-stream-prefix" = var.service_name
          }
        }
      },
      local.has_port ? { portMappings = [{ containerPort = var.container_port, protocol = "tcp" }] } : {},
      var.command != null ? { command = var.command } : {},
      local.health_check != null ? { healthCheck = local.health_check } : {},
    )
  ])
}

# --- service discovery -----------------------------------------------------------------------------

resource "aws_service_discovery_service" "this" {
  count = var.create_service && var.service_discovery_name != null ? 1 : 0
  name  = var.service_discovery_name

  dns_config {
    namespace_id   = var.service_discovery_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
  tags = var.tags
}

# --- service ---------------------------------------------------------------------------------------

resource "aws_ecs_service" "this" {
  count                              = var.create_service ? 1 : 0
  name                               = local.full_name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  health_check_grace_period_seconds  = var.enable_load_balancer ? 60 : null
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  tags                               = var.tags

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "deployment_controller" {
    for_each = var.blue_green ? [1] : []
    content {
      type = "CODE_DEPLOY"
    }
  }

  dynamic "deployment_circuit_breaker" {
    for_each = var.blue_green ? [] : [1]
    content {
      enable   = true
      rollback = true
    }
  }

  dynamic "load_balancer" {
    for_each = var.enable_load_balancer ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.service_name
      container_port   = var.container_port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this
    content {
      registry_arn = service_registries.value.arn
    }
  }

  # CI registers new task-definition revisions and CodeDeploy swaps target groups; Terraform
  # must not fight either of them or undo autoscaling.
  lifecycle {
    ignore_changes = [task_definition, desired_count, load_balancer]
  }
}

# --- autoscaling -----------------------------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  count              = var.create_service && var.enable_autoscaling ? 1 : 0
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.create_service && var.enable_autoscaling ? 1 : 0
  name               = "${local.full_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# --- CodeDeploy blue/green with canary -------------------------------------------------------------

data "aws_iam_policy_document" "codedeploy_assume" {
  count = var.blue_green ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codedeploy.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codedeploy" {
  count              = var.blue_green ? 1 : 0
  name               = "${local.full_name}-codedeploy"
  assume_role_policy = data.aws_iam_policy_document.codedeploy_assume[0].json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  count      = var.blue_green ? 1 : 0
  role       = aws_iam_role.codedeploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}

resource "aws_codedeploy_app" "this" {
  count            = var.blue_green ? 1 : 0
  name             = local.full_name
  compute_platform = "ECS"
  tags             = var.tags
}

resource "aws_codedeploy_deployment_config" "canary" {
  count                  = var.blue_green ? 1 : 0
  deployment_config_name = "${local.full_name}-canary-${var.canary_percentage}pct-${var.canary_interval_minutes}m"
  compute_platform       = "ECS"

  traffic_routing_config {
    type = "TimeBasedCanary"
    time_based_canary {
      percentage = var.canary_percentage
      interval   = var.canary_interval_minutes
    }
  }
}

resource "aws_codedeploy_deployment_group" "this" {
  count                  = var.blue_green ? 1 : 0
  app_name               = aws_codedeploy_app.this[0].name
  deployment_group_name  = local.full_name
  service_role_arn       = aws_iam_role.codedeploy[0].arn
  deployment_config_name = aws_codedeploy_deployment_config.canary[0].deployment_config_name
  tags                   = var.tags

  ecs_service {
    cluster_name = var.cluster_name
    service_name = aws_ecs_service.this[0].name
  }

  deployment_style {
    deployment_type   = "BLUE_GREEN"
    deployment_option = "WITH_TRAFFIC_CONTROL"
  }

  blue_green_deployment_config {
    deployment_ready_option {
      action_on_timeout = "CONTINUE_DEPLOYMENT"
    }
    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = var.termination_wait_minutes
    }
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [var.listener_arn]
      }
      target_group {
        name = var.blue_target_group_name
      }
      target_group {
        name = var.green_target_group_name
      }
    }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  dynamic "alarm_configuration" {
    for_each = length(var.rollback_alarm_names) > 0 ? [1] : []
    content {
      enabled = true
      alarms  = var.rollback_alarm_names
    }
  }
}
