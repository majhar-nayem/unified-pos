output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "listener_arn" {
  value = aws_lb_listener.https.arn
}

output "api_target_group_arns" {
  description = "blue/green → ARN"
  value       = { for k, v in aws_lb_target_group.api : k => v.arn }
}

output "api_target_group_names" {
  value = { for k, v in aws_lb_target_group.api : k => v.name }
}

output "api_target_group_arn_suffixes" {
  value = { for k, v in aws_lb_target_group.api : k => v.arn_suffix }
}

output "payments_target_group_arn" {
  value = aws_lb_target_group.payments.arn
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}
