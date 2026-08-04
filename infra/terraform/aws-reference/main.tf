terraform {
  required_version = ">= 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "data-room-cited"
}

resource "aws_s3_bucket" "source_documents" {
  bucket_prefix = "${var.project_name}-source-documents-"
}

resource "aws_s3_bucket_public_access_block" "source_documents" {
  bucket                  = aws_s3_bucket.source_documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ecs_cluster" "main" {
  name = var.project_name
}

resource "aws_cloudwatch_log_group" "services" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 30
}

output "source_documents_bucket" {
  value = aws_s3_bucket.source_documents.bucket
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
