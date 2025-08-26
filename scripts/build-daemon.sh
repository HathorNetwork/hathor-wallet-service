set -e
set -o pipefail

if [ -z "$ACCOUNT_ID" ]; then
    echo "Please export a ACCOUNT_ID env var before running this";
    exit 1;
fi

# Fetch the image tag from the temp file, this should be filled if the stage
# is not `dev`
DOCKER_IMAGE_TAG=$(cat /tmp/docker_image_tag 2>/dev/null || echo "")

if [ -z "$DOCKER_IMAGE_TAG" ]; then
    commit=`git rev-parse HEAD`;
    timestamp=`date +%s`;
    # Default to the dev image tag
    DOCKER_IMAGE_TAG="dev-$commit-$timestamp";
fi;

echo $DOCKER_IMAGE_TAG;
# Store the updated image tag in the tmp file so the upload stage is able to use
# it
echo $DOCKER_IMAGE_TAG > /tmp/docker_image_tag;

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;

# Fetching the daemon Dockerfile to build
docker build \
  -t $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG\
  -f packages/daemon/Dockerfile\
  .;
