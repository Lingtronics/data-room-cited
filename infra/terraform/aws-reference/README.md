# AWS Reference Architecture

This folder is a reference starting point, not a turnkey production deployment.

The intended production shape is:

- ECS/Fargate services for `web`, `orchestrator`, `mcp-server`, and `rag-core`
- An Application Load Balancer in front of web/API surfaces
- S3 for source documents
- PostgreSQL for application state, approvals, checkpoints, and future pgvector
- OpenTelemetry Collector sidecar/service exporting to the chosen observability backend
- OIDC/JWT validation at the MCP HTTP boundary
- Secrets supplied through AWS Secrets Manager or SSM Parameter Store

Before applying this for a real client, add VPC/subnet inputs, private networking,
IAM least-privilege policies, KMS keys, ECR image publishing, WAF rules, and tenant
data residency controls.
