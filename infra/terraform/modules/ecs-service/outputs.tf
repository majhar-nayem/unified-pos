output "security_group_id" {
  value = aws_security_group.this.id
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "task_role_name" {
  value = aws_iam_role.task.name
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "service_name" {
  value = var.create_service ? aws_ecs_service.this[0].name : null
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "codedeploy_app_name" {
  value = var.blue_green ? aws_codedeploy_app.this[0].name : null
}

output "codedeploy_deployment_group_name" {
  value = var.blue_green ? aws_codedeploy_deployment_group.this[0].deployment_group_name : null
}

output "codedeploy_role_arn" {
  value = var.blue_green ? aws_iam_role.codedeploy[0].arn : null
}
