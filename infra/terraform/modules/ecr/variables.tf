variable "name" {
  type = string
}

variable "repositories" {
  type    = set(string)
  default = ["api", "worker", "payments", "migrate"]
}

variable "kms_key_arn" {
  type = string
}

variable "keep_images" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
