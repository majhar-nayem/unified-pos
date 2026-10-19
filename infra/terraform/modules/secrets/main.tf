resource "aws_secretsmanager_secret" "this" {
  for_each                = var.secrets
  name                    = each.key
  description             = each.value.description
  kms_key_id              = each.value.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = var.tags
}
