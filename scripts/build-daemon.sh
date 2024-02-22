set -e
set -o pipefail

STAGE=$1

if [ -z $STAGE ]; then
    echo "This scripts expects the stage as a parameter";
    exit 1;
fi

if [ -z "$ACCOUNT_ID" ]; then
    echo "Please export a ACCOUNT_ID env var before running this";
    exit 1;
fi

commit=`git rev-parse HEAD`;
timestamp=`date +%s`;
export DOCKER_IMAGE_TAG="$1-$commit-$timestamp";

echo $DOCKER_IMAGE_TAG;
echo $DOCKER_IMAGE_TAG > /tmp/docker_image_tag;

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;

docker build -t $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG .;
