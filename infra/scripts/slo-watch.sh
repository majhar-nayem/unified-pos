#!/usr/bin/env bash
# Watch CloudWatch alarms for a window after a deployment; fail (so the pipeline can roll back) as soon as one
# of them is in ALARM. Defaults watch every alarm of the environment whose name matches the prefix.
#   PREFIX=pos-staging slo-watch.sh [minutes] [alarm-name-prefix]
set -euo pipefail

minutes="${1:-30}"
alarm_prefix="${2:-${PREFIX:?PREFIX required}-}"
interval="${SLO_WATCH_INTERVAL:-60}"
end=$((SECONDS + minutes * 60))

while [ "$SECONDS" -lt "$end" ]; do
  firing="$(aws cloudwatch describe-alarms --alarm-name-prefix "$alarm_prefix" --state-value ALARM \
    --query 'MetricAlarms[].AlarmName' --output text)"
  composite="$(aws cloudwatch describe-alarms --alarm-name-prefix "$alarm_prefix" --alarm-types CompositeAlarm \
    --state-value ALARM --query 'CompositeAlarms[].AlarmName' --output text)"
  if [ -n "${firing}${composite}" ]; then
    echo "::error::alarms firing during SLO watch: ${firing} ${composite}"
    exit 1
  fi
  echo "$(date -u +%H:%M:%S) no alarms firing; $(((end - SECONDS) / 60)) min left"
  sleep "$interval"
done
echo "SLO watch passed (${minutes} min)"
