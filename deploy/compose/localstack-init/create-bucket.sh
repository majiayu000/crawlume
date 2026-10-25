#!/bin/sh
# LocalStack (community) keeps S3 data in memory only, so recreate the artifact bucket on every start.
awslocal s3api create-bucket --bucket crawlume-artifacts >/dev/null 2>&1 || true
awslocal s3api head-bucket --bucket crawlume-artifacts
