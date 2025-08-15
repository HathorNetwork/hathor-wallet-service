set -e
set -o pipefail

echo "==== Starting migration script"
yarn sequelize db:migrate
