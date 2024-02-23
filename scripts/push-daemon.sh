set -e
set -o pipefail

DOCKER_IMAGE_TAG=$(cat /tmp/docker_image_tag)

if [ -z "$DOCKER_IMAGE_TAG" ]; then
    echo "No docker image tag on tmp file at /tmp/docker_image_tag";
    exit 1;
fi

echo $DOCKER_IMAGE_TAG;

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;

docker push $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG;
