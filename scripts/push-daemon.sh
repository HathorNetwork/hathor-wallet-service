set -e
set -o pipefail

echo $DOCKER_IMAGE_TAG;

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;

docker push $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG;
