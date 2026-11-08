#!/usr/bin/env bash
# Self-hosted fork: makes an Always Free Oracle Cloud VM for the OpenBot server.
#
#   brew install oci-cli && oci setup config        # once: API key of your Oracle account
#   selfhost/server/oracle/create-instance.sh [--ocpus 2] [--memory 12] [--retry]
#
# It makes (or reuses) the VCN "openbot", opens the ports of selfhost/server (22, 80, 443,
# 3478 tcp+udp, 49160-49200 udp), and launches an Ubuntu 24.04 VM.Standard.A1.Flex (ARM) with
# Docker. Free ARM capacity is often full; --retry keeps trying every availability domain each
# 60 s until a launch works. Prints the public IP at the end.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OCPUS=2
MEMORY=12
RETRY=0
NAME=openbot-server
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ocpus) OCPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --retry) RETRY=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
command -v oci >/dev/null || { echo "Install the OCI CLI: brew install oci-cli, then oci setup config" >&2; exit 1; }
[[ -f "$SSH_KEY" ]] || { echo "SSH public key not found: $SSH_KEY (set SSH_KEY=...)" >&2; exit 1; }

TENANCY="$(awk -F= '/^tenancy/ {gsub(/ /, "", $2); print $2; exit}' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}")"
C="${OCI_COMPARTMENT_ID:-$TENANCY}"
q() { oci "$@" --query "$QUERY" --raw-output; }

echo "▸ Network"
QUERY='data[?"display-name"==`openbot`] | [0].id'
VCN="$(q network vcn list --compartment-id "$C" --all)"
if [[ -z "$VCN" || "$VCN" == null ]]; then
  QUERY='data.id'
  VCN="$(q network vcn create --compartment-id "$C" --display-name openbot --cidr-blocks '["10.0.0.0/16"]' --dns-label openbot --wait-for-state AVAILABLE)"
  IGW="$(q network internet-gateway create --compartment-id "$C" --vcn-id "$VCN" --is-enabled true --display-name openbot-igw --wait-for-state AVAILABLE)"
  QUERY='data."default-route-table-id"'
  RT="$(q network vcn get --vcn-id "$VCN")"
  oci network route-table update --rt-id "$RT" --force \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
fi
QUERY='data."default-security-list-id"'
SL="$(q network vcn get --vcn-id "$VCN")"
oci network security-list update --security-list-id "$SL" --force --ingress-security-rules "$(cat <<'JSON'
[
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":3478,"max":3478}}},
  {"protocol":"17","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":3478,"max":3478}}},
  {"protocol":"17","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":49160,"max":49200}}},
  {"protocol":"1","source":"0.0.0.0/0","icmpOptions":{"type":3,"code":4}}
]
JSON
)" >/dev/null
QUERY='data[?"display-name"==`openbot-public`] | [0].id'
SUBNET="$(q network subnet list --compartment-id "$C" --vcn-id "$VCN")"
if [[ -z "$SUBNET" || "$SUBNET" == null ]]; then
  QUERY='data.id'
  SUBNET="$(q network subnet create --compartment-id "$C" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 \
    --display-name openbot-public --dns-label public --security-list-ids "[\"$SL\"]" --wait-for-state AVAILABLE)"
fi

echo "▸ Image"
QUERY='data[0].id'
IMAGE="$(q compute image list --compartment-id "$C" --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC)"
[[ -n "$IMAGE" && "$IMAGE" != null ]] || { echo "No Ubuntu 24.04 ARM image found" >&2; exit 1; }

QUERY='data[?"display-name"==`'"$NAME"'` && "lifecycle-state"!=`TERMINATED`] | [0].id'
INSTANCE="$(q compute instance list --compartment-id "$C")"
if [[ -z "$INSTANCE" || "$INSTANCE" == null ]]; then
  ADS=()
  while IFS= read -r line; do [[ -n "$line" ]] && ADS+=("$line"); done < <(
    oci iam availability-domain list --compartment-id "$C" --query 'data[].name' --raw-output | tr -d '[]", ')
  echo "▸ Launch $OCPUS OCPU / $MEMORY GB in ${ADS[*]}"
  while :; do
    for AD in "${ADS[@]}"; do
      if OUTPUT="$(oci compute instance launch --compartment-id "$C" --availability-domain "$AD" \
        --display-name "$NAME" --shape VM.Standard.A1.Flex \
        --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY}" \
        --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
        --boot-volume-size-in-gbs 100 \
        --ssh-authorized-keys-file "$SSH_KEY" --user-data-file "$DIR/cloud-init.yaml" \
        --wait-for-state RUNNING --query 'data.id' --raw-output 2>&1)"; then
        INSTANCE="$OUTPUT"
        break 2
      fi
      if grep -qi "capacity" <<<"$OUTPUT"; then
        echo "  $AD: out of capacity"
      else
        echo "$OUTPUT" >&2
        exit 1
      fi
    done
    [[ "$RETRY" == 1 ]] || { echo "No capacity now. Run again with --retry, or try --ocpus 1 --memory 6." >&2; exit 1; }
    sleep 60
  done
fi

QUERY='data[0]."public-ip"'
IP="$(q compute instance list-vnics --instance-id "$INSTANCE")"
echo "✓ $NAME is running: ubuntu@$IP"
echo "  Next: DNS A records api.<domain> and signal.<domain> → $IP, TURN_PUBLIC_IP=$IP in selfhost/server/.env,"
echo "        then selfhost/server/scripts/deploy.sh ubuntu@$IP"
