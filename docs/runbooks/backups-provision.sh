#!/usr/bin/env bash
# Provision (and verify) Postroom's offsite backup target — PST-T-0.16, PST-REQ-022, PST-REQ-024.
# See docs/runbooks/backups.md for what each piece is for.
#
#   ./backups-provision.sh provision   # as an AWS admin: KMS key, bucket, lifecycle, put-only IAM user
#   ./backups-provision.sh verify      # as the admin AND with the backup user's keys: checks every promise
#
# Needs the AWS CLI v2 and jq. Run `provision` with an admin profile (AWS_PROFILE=...). It is safe to
# re-run: every step checks before it creates, and the access key is only minted when the user has none.
set -euo pipefail

BUCKET="${BUCKET:-postroom-backups-d3cloud}"
REGION="${REGION:-us-east-1}"
KEY_ALIAS="${KEY_ALIAS:-alias/postroom-backups}"
USER_NAME="${USER_NAME:-postroom-backup}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

aws_() { aws --region "$REGION" --output json "$@"; }
say() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

key_arn() {
  aws_ kms describe-key --key-id "$KEY_ALIAS" --query 'KeyMetadata.Arn' --output text
}

provision() {
  local account
  account=$(aws_ sts get-caller-identity --query Account --output text)

  say "KMS key $KEY_ALIAS"
  if ! aws_ kms describe-key --key-id "$KEY_ALIAS" >/dev/null 2>&1; then
    local key_id
    key_id=$(aws_ kms create-key --description 'Postroom backups (SSE-KMS)' --query 'KeyMetadata.KeyId' --output text)
    aws_ kms create-alias --alias-name "$KEY_ALIAS" --target-key-id "$key_id"
    aws_ kms enable-key-rotation --key-id "$key_id"
  fi
  local kms_arn
  kms_arn=$(key_arn)
  echo "$kms_arn"

  say "Bucket s3://$BUCKET"
  if ! aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    if [ "$REGION" = "us-east-1" ]; then
      aws_ s3api create-bucket --bucket "$BUCKET" >/dev/null
    else
      aws_ s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
  fi
  aws_ s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws_ s3api put-bucket-ownership-controls --bucket "$BUCKET" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
  aws_ s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws_ s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration "$(jq -n --arg k "$kms_arn" '{
    Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: $k }, BucketKeyEnabled: true }]
  }')"

  say "Lifecycle: ${RETENTION_DAYS}-day versions"
  aws_ s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "$(jq -n --argjson d "$RETENTION_DAYS" '{
    Rules: [
      { ID: "noncurrent-versions", Status: "Enabled", Filter: { Prefix: "" },
        NoncurrentVersionExpiration: { NoncurrentDays: $d },
        Expiration: { ExpiredObjectDeleteMarker: true },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
      { ID: "nightly-dumps", Status: "Enabled", Filter: { Prefix: "db/" },
        Expiration: { Days: $d } }
    ]
  }')"

  say "Bucket policy: TLS only, SSE-KMS with this key only"
  aws_ s3api put-bucket-policy --bucket "$BUCKET" --policy "$(jq -n --arg b "$BUCKET" --arg k "$kms_arn" '{
    Version: "2012-10-17",
    Statement: [
      { Sid: "DenyInsecureTransport", Effect: "Deny", Principal: "*", Action: "s3:*",
        Resource: ["arn:aws:s3:::\($b)", "arn:aws:s3:::\($b)/*"],
        Condition: { Bool: { "aws:SecureTransport": "false" } } },
      { Sid: "DenyUnencryptedPuts", Effect: "Deny", Principal: "*", Action: "s3:PutObject",
        Resource: "arn:aws:s3:::\($b)/*",
        Condition: { StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" } } },
      { Sid: "DenyOtherKmsKeys", Effect: "Deny", Principal: "*", Action: "s3:PutObject",
        Resource: "arn:aws:s3:::\($b)/*",
        Condition: { StringNotEquals: { "s3:x-amz-server-side-encryption-aws-kms-key-id": $k } } }
    ]
  }')"

  say "IAM user $USER_NAME (put/get/list only; delete explicitly denied)"
  if ! aws_ iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
    aws_ iam create-user --user-name "$USER_NAME" >/dev/null
  fi
  aws_ iam put-user-policy --user-name "$USER_NAME" --policy-name postroom-backup-put-only --policy-document "$(jq -n --arg b "$BUCKET" --arg k "$kms_arn" '{
    Version: "2012-10-17",
    Statement: [
      { Sid: "WriteAndReadObjects", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject"], Resource: "arn:aws:s3:::\($b)/*" },
      { Sid: "ListTheBucket", Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::\($b)" },
      { Sid: "UseTheBackupKey", Effect: "Allow", Action: ["kms:GenerateDataKey", "kms:Decrypt"], Resource: $k },
      { Sid: "NeverDelete", Effect: "Deny",
        Action: ["s3:DeleteObject*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning",
                 "s3:PutBucketPolicy", "s3:PutEncryptionConfiguration", "s3:PutObjectRetention", "s3:BypassGovernanceRetention"],
        Resource: ["arn:aws:s3:::\($b)", "arn:aws:s3:::\($b)/*"] },
      { Sid: "NeverTouchTheKey", Effect: "Deny",
        Action: ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy", "kms:CreateGrant"], Resource: $k }
    ]
  }')"

  local keys
  keys=$(aws_ iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)
  say "Environment for the Postroom host's .env"
  if [ "$keys" = "0" ]; then
    local created
    created=$(aws_ iam create-access-key --user-name "$USER_NAME")
    echo "AWS_ACCESS_KEY_ID=$(jq -r .AccessKey.AccessKeyId <<<"$created")"
    echo "AWS_SECRET_ACCESS_KEY=$(jq -r .AccessKey.SecretAccessKey <<<"$created")"
    echo "# ^ shown once. Put both in the host's .env now."
  else
    echo "# $USER_NAME already has an access key; reuse the one in the host's .env (or rotate it by hand)."
  fi
  echo "AWS_REGION=$REGION"
  echo "BACKUP_BUCKET=$BUCKET"
  echo "BACKUP_KMS_KEY_ID=$kms_arn"
  echo "BACKUP_KEK_PASSPHRASE=<from the password manager; never stored anywhere else>"
  echo "# account $account"
}

verify() {
  # Two identities: the admin (AWS_PROFILE) reads the bucket's configuration; the backup user
  # (BACKUP_AWS_ACCESS_KEY_ID / BACKUP_AWS_SECRET_ACCESS_KEY) proves what it can and cannot do.
  : "${BACKUP_AWS_ACCESS_KEY_ID:?set BACKUP_AWS_ACCESS_KEY_ID to the backup user key}"
  : "${BACKUP_AWS_SECRET_ACCESS_KEY:?set BACKUP_AWS_SECRET_ACCESS_KEY to the backup user secret}"
  local today
  today=$(date -u +%Y-%m-%d)
  as_backup() { env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY" aws --region "$REGION" --output json "$@"; }

  say "Versioning is Enabled"
  [ "$(aws_ s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)" = "Enabled" ] || die "versioning is not Enabled"

  say "Default encryption is SSE-KMS"
  aws_ s3api get-bucket-encryption --bucket "$BUCKET" \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text | grep -qx 'aws:kms' \
    || die "default encryption is not aws:kms"

  say "Lifecycle is ${RETENTION_DAYS} days"
  local lc
  lc=$(aws_ s3api get-bucket-lifecycle-configuration --bucket "$BUCKET")
  echo "$lc" | jq -e --argjson d "$RETENTION_DAYS" '.Rules[] | select(.ID == "noncurrent-versions") | .NoncurrentVersionExpiration.NoncurrentDays == $d' >/dev/null \
    || die "noncurrent versions do not expire after $RETENTION_DAYS days"
  echo "$lc" | jq -e --argjson d "$RETENTION_DAYS" '.Rules[] | select(.ID == "nightly-dumps") | .Expiration.Days == $d' >/dev/null \
    || die "db/ dumps do not expire after $RETENTION_DAYS days"

  say "Tonight's objects are in the bucket (db/$today/)"
  as_backup s3 ls "s3://$BUCKET/db/$today/" || die "nothing under db/$today/ — has tonight's backup run? (postroom backup)"
  as_backup s3api head-object --bucket "$BUCKET" --key "db/$today/manifest.json" \
    --query '{bytes: ContentLength, sse: ServerSideEncryption, key: SSEKMSKeyId}' || die "no manifest for $today"

  say "The backup user's delete is denied"
  local out
  if out=$(as_backup s3api delete-object --bucket "$BUCKET" --key "db/$today/manifest.json" 2>&1); then
    die "delete-object SUCCEEDED for the backup user — the IAM policy is wrong: $out"
  fi
  echo "$out" | grep -q 'AccessDenied' || die "delete failed, but not with AccessDenied: $out"
  echo "denied, as it should be: $out"

  say "All backup promises hold"
}

case "${1:-}" in
  provision) provision ;;
  verify) verify ;;
  *) echo "usage: $0 <provision|verify>" >&2; exit 2 ;;
esac
