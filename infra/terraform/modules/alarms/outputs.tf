output "page_topic_arn" {
  value = aws_sns_topic.page.arn
}

output "ticket_topic_arn" {
  value = aws_sns_topic.ticket.arn
}

output "rollback_alarm_names" {
  description = "Alarms that should stop a blue/green deployment"
  value = concat(
    [aws_cloudwatch_metric_alarm.alb_elb_5xx.alarm_name],
    [for c in aws_cloudwatch_composite_alarm.app : c.alarm_name if length(regexall("slo-availability-(fast|slow)-burn$", c.alarm_name)) > 0],
  )
}
