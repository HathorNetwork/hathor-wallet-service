set -e;

send_slack_message() {
    MESSAGE=$1;

    curl -H "Content-type: application/json" \
        --data "{\"channel\":\"${SLACK_DEPLOYS_CHANNEL_ID}\",\"blocks\":[{\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*Hathor Wallet Service*\n${MESSAGE}\"}}]}" \
        -H "Authorization: Bearer ${SLACK_OAUTH_TOKEN}" \
        -X POST https://slack.com/api/chat.postMessage;
}

deploy_hathor_network_account() {
    exit=false;

    # Checks whether there is a file called "rollback_mainnet_production", which is used by our other CodeBuild to indicate that this is a mainnet-production rollback
    if [ -f "rollback_mainnet_production" ]; then
        # Gets all env vars with `mainnet_` prefix and re-exports them without the prefix
        for var in "${!mainnet_@}"; do
            export ${var#mainnet_}="${!var}"
        done
        make deploy-lambdas-mainnet;
        send_slack_message "Rollback performed on mainnet-production to: ${GIT_REF_TO_DEPLOY}";
        exit=true;
    fi;

    # Checks whether there is a file called "rollback_testnet_production", which is used by our other CodeBuild to indicate that this is a testnet-production rollback
    if [ -f "rollback_testnet_production" ]; then
        # Gets all env vars with `testnet_` prefix and re-exports them without the prefix
        for var in "${!testnet_@}"; do
            export ${var#testnet_}="${!var}"
        done
        make deploy-lambdas-testnet;
        send_slack_message "Rollback performed on testnet-production to: ${GIT_REF_TO_DEPLOY}";
        exit=true;
    fi;

    if [ "$exit" = true ]; then
    echo "Rollbacks performed successfully. Exiting now.";
    exit 0;
    fi

    if expr "${GIT_REF_TO_DEPLOY}" : "master" >/dev/null; then
        # Gets all env vars with `dev_` prefix and re-exports them without the prefix
        for var in "${!dev_@}"; do
            export ${var#dev_}="${!var}"
        done

        make migrate;
        make build-daemon;
        make deploy-lambdas-dev-testnet;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;

    elif expr "${GIT_REF_TO_DEPLOY}" : "v[0-9]\+\.[0-9]\+\.[0-9]\+-rc\.[0-9]\+" >/dev/null; then
        # Gets all env vars with `mainnet_staging_` prefix and re-exports them without the prefix
        for var in "${!mainnet_staging_@}"; do
            export ${var#mainnet_staging_}="${!var}"
        done

        echo $GIT_REF_TO_DEPLOY > /tmp/docker_image_tag
        make migrate;
        make build-daemon;
        make deploy-lambdas-mainnet-staging;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;
        send_slack_message "New version deployed to mainnet-staging: ${GIT_REF_TO_DEPLOY}"
    elif expr "${GIT_REF_TO_DEPLOY}" : "v.*" >/dev/null; then
        echo $GIT_REF_TO_DEPLOY > /tmp/docker_image_tag

        # --- Testnet ---
        # Gets all env vars with `testnet_` prefix and re-exports them without the prefix
        for var in "${!testnet_@}"; do
            export ${var#testnet_}="${!var}"
        done

        make migrate;
        make build-daemon;
        make deploy-lambdas-testnet;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;

        # Unsets all the testnet env vars so we make sure they don't leak to other deploys
        for var in "${!testnet_@}"; do
            unset ${var#testnet_}
        done

        send_slack_message "New version deployed to testnet-production: ${GIT_REF_TO_DEPLOY}"

        # --- Testnet Hotel ---
        # Gets all env vars with `testnethotel_` prefix and re-exports them without the prefix
        for var in "${!testnethotel_@}"; do
            export ${var#testnethotel_}="${!var}"
        done

        make migrate;
        make build-daemon;
        make deploy-lambdas-testnet-hotel;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;

        # Unsets all the testnet env vars so we make sure they don't leak to other deploys
        for var in "${!testnethotel_@}"; do
            unset ${var#testnethotel_}
        done

        send_slack_message "New version deployed to testnet-hotel: ${GIT_REF_TO_DEPLOY}"

        # --- Testnet India ---
        # Gets all env vars with `testnetindia_` prefix and re-exports them without the prefix
        for var in "${!testnetindia_@}"; do
            export ${var#testnetindia_}="${!var}"
        done

        make migrate;
        make build-daemon;
        make deploy-lambdas-testnet-india;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;

        # Unsets all the testnet env vars so we make sure they don't leak to other deploys
        for var in "${!testnetindia_@}"; do
            unset ${var#testnetindia_}
        done

        send_slack_message "New version deployed to testnet-india: ${GIT_REF_TO_DEPLOY}"

        # --- Mainnet ---
        # Gets all env vars with `mainnet_` prefix and re-exports them without the prefix
        for var in "${!mainnet_@}"; do
            export ${var#mainnet_}="${!var}"
        done
        make migrate;
        make build-daemon;
        make deploy-lambdas-mainnet;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;

        # Unsets all the mainnet env vars so we make sure they don't leak to other deploys
        for var in "${!mainnet_@}"; do
            unset ${var#mainnet_}
        done

        send_slack_message "New version deployed to mainnet-production: ${GIT_REF_TO_DEPLOY}"
    else
        # Gets all env vars with `dev_` prefix and re-exports them without the prefix
        for var in "${!dev_@}"; do
            export ${var#dev_}="${!var}"
        done
        make migrate;
        make build-daemon;
        make deploy-lambdas-dev-testnet;
        # The idea here is that if the lambdas deploy fail, the built image won't be pushed:
        make push-daemon;
    fi;
}

deploy_ekvilibro_mainnet() {
    # Deploys the releases to our ekvilibro-mainnet environment

    # We deploy only the Lambdas here, because the daemon used in ekvilibro-testnet is the same as
    # the one built in the hathor-network account, since it runs there as well

    echo "Building git ref ${GIT_REF_TO_DEPLOY}..."

    # This will match release-candidates
    if expr "${GIT_REF_TO_DEPLOY}" : "v[0-9]\+\.[0-9]\+\.[0-9]\+-rc\.[0-9]\+" >/dev/null; then
        echo "We don't deploy ${GIT_REF_TO_DEPLOY} to ekvilibro-mainnet. Nothing to do.";
    # This will match releases only (since release-candidates are already matched above)
    elif expr "${GIT_REF_TO_DEPLOY}" : "v.*" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-mainnet;

        send_slack_message "New version deployed to ekvilibro-mainnet: ${GIT_REF_TO_DEPLOY}"
    elif expr "${MANUAL_DEPLOY}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-mainnet;

        send_slack_message "Branch manually deployed to ekvilibro-mainnet: ${GIT_REF_TO_DEPLOY}"
    elif expr "${ROLLBACK}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-mainnet;

        send_slack_message "Rollback performed on ekvilibro-mainnet to: ${GIT_REF_TO_DEPLOY}";
    else
        echo "We don't deploy ${GIT_REF_TO_DEPLOY} to ekvilibro-mainnet. Nothing to do.";
    fi;

}

deploy_ekvilibro_testnet() {
    # Deploys the release-candidates and releases to our ekvilibro-testnet environment

    # We deploy only the Lambdas here, because the daemon used in ekvilibro-testnet is the same as
    # the one built in the hathor-network account, since it runs there as well

    echo "Building git ref ${GIT_REF_TO_DEPLOY}..."

    # This will match release-candidates or releases
    if expr "${GIT_REF_TO_DEPLOY}" : "v.*" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-testnet;

        send_slack_message "New version deployed to ekvilibro-testnet: ${GIT_REF_TO_DEPLOY}"
    elif expr "${MANUAL_DEPLOY}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-testnet;

        send_slack_message "Branch manually deployed to ekvilibro-testnet: ${GIT_REF_TO_DEPLOY}"
    elif expr "${ROLLBACK}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-ekvilibro-testnet;

        send_slack_message "Rollback performed on ekvilibro-testnet to: ${GIT_REF_TO_DEPLOY}";
    else
        echo "We don't deploy ${GIT_REF_TO_DEPLOY} to ekvilibro-testnet. Nothing to do.";
    fi;
}

deploy_testnet_playground() {
    # Deploys the release-candidates and releases to our testnet-playground environment

    # We deploy only the Lambdas here, because the daemon used in testnet-playground is the same as
    # the one built in the hathor-network account, since it runs there as well

    echo "Building git ref ${GIT_REF_TO_DEPLOY}..."

    # This will match release-candidates or releases
    if expr "${GIT_REF_TO_DEPLOY}" : "v.*" >/dev/null; then
        make migrate;
        make deploy-lambdas-testnet-playground;

        send_slack_message "New version deployed to testnet-playground: ${GIT_REF_TO_DEPLOY}"
    elif expr "${MANUAL_DEPLOY}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-testnet-playground;

        send_slack_message "Branch manually deployed to testnet-playground: ${GIT_REF_TO_DEPLOY}"
    elif expr "${ROLLBACK}" : "true" >/dev/null; then
        make migrate;
        make deploy-lambdas-testnet-playground;

        send_slack_message "Rollback performed on testnet-playground to: ${GIT_REF_TO_DEPLOY}";
    else
        echo "We don't deploy ${GIT_REF_TO_DEPLOY} to testnet-playground. Nothing to do.";
    fi;
}


# Check the first argument for the desired deploy
option=$1

case $option in
    # This will be triggered from /.codebuild/buildspec.yml in this repo
    hathor-network)
        deploy_hathor_network_account
        ;;
    ekvilibro-testnet)
        deploy_ekvilibro_testnet
        ;;
    ekvilibro-mainnet)
        deploy_ekvilibro_mainnet
        ;;
    testnet-playground)
        deploy_testnet_playground
        ;;
    *)
        echo "Invalid option: $option"
        exit 1
        ;;
esac