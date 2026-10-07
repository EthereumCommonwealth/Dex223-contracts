#!/usr/bin/env bash
# Deploys the DEX223 fee keeper to the RORO AWS account (680302448261, us-east-1). Safe to re-run: it
# creates what is missing and updates the code and settings of what exists.
#
#   ops/fee-keeper-lambda/deploy.sh              # from the repo root, with AWS credentials configured
#   ALERT_EMAIL=you@example.com ops/fee-keeper-lambda/deploy.sh
#
# The secret dex223/fee-keeper ({"privateKey","etherscanApiKey"}) is created separately; see README.md.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME=dex223-fee-keeper
ROLE=dex223-fee-keeper-role
TOPIC=dex223-fee-keeper-alerts
SCHEDULE="${SCHEDULE:-cron(0 6 * * ? *)}"      # daily 06:00 UTC
ALERT_EMAIL="${ALERT_EMAIL:-ranroland@gmail.com}"
MIN_BALANCE_ETH="${MIN_BALANCE_ETH:-0.005}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
SECRET_ARN="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:dex223/fee-keeper-*"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

echo "== bundle"
rm -rf "$HERE/dist" && mkdir -p "$HERE/dist"
npx --yes esbuild@0.24.0 "$HERE/index.mjs" --bundle --platform=node --target=node22 --format=esm \
  --external:@aws-sdk/* --outfile="$HERE/dist/index.mjs" --log-level=warning
(cd "$HERE/dist" && zip -q -j function.zip index.mjs)

echo "== IAM role"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "DEX223 fee keeper Lambda" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # let the new role propagate before Lambda uses it
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name fee-keeper --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"$SECRET_ARN"},
  {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*",
   "Condition":{"StringEquals":{"cloudwatch:namespace":"DEX223/FeeKeeper"}}}
]}
JSON
)"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

echo "== Lambda"
ENV='{"Variables":{"NETWORKS":"mainnet,sepolia","SECRET_ID":"dex223/fee-keeper"}}'
if aws lambda get-function --function-name "$NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$NAME" --zip-file "fileb://$HERE/dist/function.zip" >/dev/null
  aws lambda wait function-updated --function-name "$NAME"
  aws lambda update-function-configuration --function-name "$NAME" --timeout 600 --memory-size 256 \
    --environment "$ENV" >/dev/null
else
  aws lambda create-function --function-name "$NAME" --runtime nodejs22.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file "fileb://$HERE/dist/function.zip" --timeout 600 --memory-size 256 \
    --description "DEX223: enable protocol fees, collect them into RevenueV2 and start reward streams" \
    --environment "$ENV" >/dev/null
fi
aws lambda wait function-active-v2 --function-name "$NAME"
FN_ARN="$(aws lambda get-function --function-name "$NAME" --query Configuration.FunctionArn --output text)"

echo "== schedule ($SCHEDULE)"
RULE_ARN="$(aws events put-rule --name "$NAME-daily" --schedule-expression "$SCHEDULE" \
  --description "Run the DEX223 fee keeper" --query RuleArn --output text)"
aws events put-targets --rule "$NAME-daily" --targets "Id=keeper,Arn=$FN_ARN" >/dev/null
aws lambda add-permission --function-name "$NAME" --statement-id events-daily --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 || true

echo "== alerts to $ALERT_EMAIL"
TOPIC_ARN="$(aws sns create-topic --name "$TOPIC" --query TopicArn --output text)"
if ! aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query "Subscriptions[].Endpoint" --output text | grep -q "$ALERT_EMAIL"; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
  echo "   confirmation email sent to $ALERT_EMAIL: click the link in it to receive alerts"
fi
aws cloudwatch put-metric-alarm --alarm-name "$NAME-failed" \
  --alarm-description "A DEX223 fee keeper run failed (a transaction reverted, an RPC or Etherscan error, or a missing secret). Check the Lambda's CloudWatch logs." \
  --namespace AWS/Lambda --metric-name Errors --dimensions "Name=FunctionName,Value=$NAME" \
  --statistic Sum --period 86400 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN"
aws cloudwatch put-metric-alarm --alarm-name "$NAME-mainnet-gas-low" \
  --alarm-description "The fee keeper wallet has less than $MIN_BALANCE_ETH ETH on mainnet. Top it up." \
  --namespace DEX223/FeeKeeper --metric-name KeeperBalanceEth --dimensions "Name=Network,Value=mainnet" \
  --statistic Minimum --period 86400 --evaluation-periods 1 --threshold "$MIN_BALANCE_ETH" --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN"
aws cloudwatch put-metric-alarm --alarm-name "$NAME-not-running" \
  --alarm-description "The fee keeper has not run in two days." \
  --namespace AWS/Lambda --metric-name Invocations --dimensions "Name=FunctionName,Value=$NAME" \
  --statistic Sum --period 86400 --evaluation-periods 2 --threshold 1 --comparison-operator LessThanThreshold \
  --treat-missing-data breaching --alarm-actions "$TOPIC_ARN"

echo "== done: $FN_ARN"
echo "   dry run:  aws lambda invoke --function-name $NAME --payload '{\"dryRun\":true}' --cli-binary-format raw-in-base64-out /dev/stdout"
