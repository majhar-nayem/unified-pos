output "security_group_id" {
  value = module.service.security_group_id
}

output "task_role_arn" {
  value = module.service.task_role_arn
}

output "emf_log_group" {
  value = aws_cloudwatch_log_group.emf.name
}
