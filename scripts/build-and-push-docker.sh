set -e
set -o pipefail

if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo "Please export a AWS_ACCOUNT_ID env var before running this";
    exit 1;
fi

if [ -z "$DOCKER_IMAGE_TAG" ]; then
    commit=`git rev-parse HEAD`;
    timestamp=`date +%s`;
    export DOCKER_IMAGE_TAG="dev-$commit-$timestamp";
fi;

echo $DOCKER_IMAGE_TAG;

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;

docker build -t $AWS_ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG .;

docker push $AWS_ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG;
