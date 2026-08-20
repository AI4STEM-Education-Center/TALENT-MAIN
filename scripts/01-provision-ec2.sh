#!/usr/bin/env bash
# ============================================================================
# 01 — Create the EC2 instance and its network perimeter.
#
# WHERE: your laptop (needs the AWS CLI logged in with permission to create
#        EC2 resources).
# TIME:  ~2 minutes.
#
#   cp scripts/config.env.example scripts/config.env && $EDITOR scripts/config.env
#   chmod 600 scripts/config.env
#   ./scripts/01-provision-ec2.sh
#
# Creates, and is safe to re-run — every step checks before it creates:
#   - an SSH key pair, private key saved to $EC2_KEY_FILE
#   - a security group: 443 from Cloudflare only, key-only 22 for GitHub Actions
#   - the instance itself, IMDSv2-only, gp3 encrypted root
#
# There is deliberately no Elastic IP. The public address is allowed to change;
# the DDNS updater from 05 keeps the Cloudflare records pointed at it, which is
# the cheaper half of the trade and removes a resource that bills when idle.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
need_cmd aws jq curl
require_vars PROJECT AWS_REGION EC2_INSTANCE_NAME EC2_INSTANCE_TYPE \
             EC2_KEY_NAME EC2_KEY_FILE EC2_AMI_SSM_PARAM EC2_VOLUME_GB

SG_NAME="${PROJECT}-edge"

step "Checking AWS identity"
ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text) \
  || die "AWS CLI is not authenticated — run 'aws configure' or set AWS_PROFILE in config.env"
ok "account ${ACCOUNT}, region ${AWS_REGION}"

# ---------------------------------------------------------------------------
step "Resolving the Debian AMI"
# ---------------------------------------------------------------------------
AMI_ID=$(aws_ ssm get-parameter --name "$EC2_AMI_SSM_PARAM" \
           --query 'Parameter.Value' --output text 2>/dev/null || true)
if [[ -z "$AMI_ID" || "$AMI_ID" == "None" ]]; then
  # Debian does not publish the SSM parameter in every region. Fall back to the
  # newest image owned by Debian's AWS account (136693071363).
  warn "SSM parameter $EC2_AMI_SSM_PARAM not available, falling back to image search"
  AMI_ID=$(aws_ ec2 describe-images --owners 136693071363 \
            --filters 'Name=name,Values=debian-12-amd64-*' 'Name=state,Values=available' \
            --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
fi
[[ -n "$AMI_ID" && "$AMI_ID" != "None" ]] || die "could not resolve an AMI"
ok "AMI ${AMI_ID}"

# ---------------------------------------------------------------------------
step "SSH key pair"
# ---------------------------------------------------------------------------
if aws_ ec2 describe-key-pairs --key-names "$EC2_KEY_NAME" >/dev/null 2>&1; then
  ok "key pair ${EC2_KEY_NAME} already exists"
  [[ -f "$EC2_KEY_FILE" ]] || warn "but $EC2_KEY_FILE is missing — AWS will not re-issue a private key. Delete the key pair and re-run if you need it."
else
  mkdir -p "$(dirname "$EC2_KEY_FILE")"
  aws_ ec2 create-key-pair --key-name "$EC2_KEY_NAME" \
    --key-type ed25519 \
    --query 'KeyMaterial' --output text > "$EC2_KEY_FILE"
  chmod 400 "$EC2_KEY_FILE"
  ok "created ${EC2_KEY_NAME}, private key at ${EC2_KEY_FILE}"
fi

# ---------------------------------------------------------------------------
step "Fetching Cloudflare edge ranges"
# ---------------------------------------------------------------------------
CF_V4=$(cf_edge_ranges_v4)
CF_V6=$(cf_edge_ranges_v6)
CF_TOTAL=$(( $(wc -l <<<"$CF_V4") + $(wc -l <<<"$CF_V6") ))
[[ "$CF_TOTAL" -ge 10 ]] || die "only ${CF_TOTAL} Cloudflare ranges returned"
ok "${CF_TOTAL} ranges"

# ---------------------------------------------------------------------------
step "Security group"
# ---------------------------------------------------------------------------
VPC_ID=$(aws_ ec2 describe-vpcs --filters 'Name=is-default,Values=true' \
          --query 'Vpcs[0].VpcId' --output text)
[[ "$VPC_ID" != "None" ]] || die "no default VPC in ${AWS_REGION} — create one, or set a VPC id here by hand"

SG_ID=$(aws_ ec2 describe-security-groups \
         --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
         --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  SG_ID=$(aws_ ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$VPC_ID" \
           --description "${PROJECT}: Cloudflare HTTPS plus key-only SSH" \
           --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PROJECT}}]" \
           --query 'GroupId' --output text)
  ok "created ${SG_NAME} (${SG_ID})"
else
  ok "${SG_NAME} exists (${SG_ID})"
fi

sync_cloudflare_https_rules "$SG_ID" "$CF_V4" "$CF_V6"
sync_public_key_ssh_rule "$SG_ID"
prune_unmanaged_ingress_rules "$SG_ID" "$CF_V4" "$CF_V6"
ok "443 restricted to Cloudflare; 22 open for public-key-only SSH"

# Remove prefix lists created by the superseded implementation after all of
# their security-group references are gone. If a list was reused elsewhere,
# AWS refuses the delete and we leave it alone with a warning.
for legacy_name in "${PROJECT}-cloudflare-v4" "${PROJECT}-cloudflare-v6"; do
  legacy_id=$(aws_ ec2 describe-managed-prefix-lists \
    --filters "Name=prefix-list-name,Values=${legacy_name}" \
    --query 'PrefixLists[0].PrefixListId' --output text 2>/dev/null || true)
  if [[ -n "$legacy_id" && "$legacy_id" != None ]]; then
    if aws_ ec2 delete-managed-prefix-list --prefix-list-id "$legacy_id" >/dev/null 2>&1; then
      info "deleted obsolete prefix list ${legacy_name}"
    else
      warn "could not delete obsolete prefix list ${legacy_name}; it may still be referenced"
    fi
  fi
done

# ---------------------------------------------------------------------------
step "Instance"
# ---------------------------------------------------------------------------
INSTANCE_ID=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=${EC2_INSTANCE_NAME}" \
            'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)

if [[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "None" ]]; then
  ok "instance ${EC2_INSTANCE_NAME} already exists (${INSTANCE_ID}) — not recreating"
else
  INSTANCE_ID=$(aws_ ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$EC2_INSTANCE_TYPE" \
    --key-name "$EC2_KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${EC2_VOLUME_GB},\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
    --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${EC2_INSTANCE_NAME}},{Key=Project,Value=${PROJECT}}]" \
    --query 'Instances[0].InstanceId' --output text)
  ok "launched ${INSTANCE_ID}"
fi

# IMDSv2 with a hop limit of 1 means a process inside a container cannot reach
# the metadata endpoint at all. That is intentional and safe here: the app is
# given static AWS keys in its .env and getAwsCredentials() refuses to fall
# back to an instance role, so nothing legitimate needs IMDS.

step "Waiting for the instance to reach running"
aws_ ec2 wait instance-running --instance-ids "$INSTANCE_ID"
PUBLIC_IP=$(aws_ ec2 describe-instances --instance-ids "$INSTANCE_ID" \
             --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ok "running at ${PUBLIC_IP}"

state_set INSTANCE_ID "$INSTANCE_ID"
state_set PUBLIC_IP   "$PUBLIC_IP"
state_set SG_ID       "$SG_ID"
state_unset PL4_ID PL6_ID

cat <<EOF

${c_green}Instance ready.${c_reset}

  ssh -i ${EC2_KEY_FILE} ${EC2_USER}@${PUBLIC_IP}

Next: copy the scripts to the box and run 02.

  scp -i ${EC2_KEY_FILE} -r scripts ${EC2_USER}@${PUBLIC_IP}:~/setup
  ssh -i ${EC2_KEY_FILE} ${EC2_USER}@${PUBLIC_IP} 'cd ~/setup && ./02-bootstrap-box.sh'

SSH may refuse for the first ~30s while cloud-init installs the key.
EOF
