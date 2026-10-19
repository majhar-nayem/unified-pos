variable "name" {
  type = string
}

variable "account_id" {
  description = "Account that owns the keys (passed in so planning needs no STS call)"
  type        = string
}

variable "keys" {
  description = "Key purpose → description. Each becomes a CMK with alias alias/<name>-<purpose>."
  type        = map(string)
}

variable "deletion_window_in_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
