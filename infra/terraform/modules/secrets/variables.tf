variable "secrets" {
  description = "Secret name → { description, kms_key_arn }. Values are set out of band (runbooks/deploy.md); Terraform never holds them."
  type = map(object({
    description = string
    kms_key_arn = string
  }))
}

variable "recovery_window_in_days" {
  type    = number
  default = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
