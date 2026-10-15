#!/usr/bin/env bash
# Installs the package from a registry (local-registry.sh's) into a new
# project, install scripts off, and copies in the smoke test. "yarn" is Yarn
# Plug'n'Play: run with `yarn node`.
#
#   install-package.sh npm|pnpm|bun|yarn <registry url> <project dir>
set -euo pipefail

installer=$1
registry=${2:?no registry url}
dir=$3
here=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$dir"
cd "$dir"
echo '{ "name": "smoke", "private": true, "type": "module" }' >package.json
cp "$here/../smoke.mjs" .
# Only @handy-computer comes from the local registry.
echo "@handy-computer:registry=$registry" >.npmrc

case $installer in
    npm)
        npm install --ignore-scripts --no-audit --no-fund @handy-computer/recorder@ci
        # At most this platform's binary package came with it (none on musl).
        ls node_modules/@handy-computer
        test "$(ls node_modules/@handy-computer | grep -c '^recorder-')" -le 1
        ;;
    pnpm) npx --yes pnpm@10 add --ignore-scripts @handy-computer/recorder@ci ;;
    bun) bun add --ignore-scripts @handy-computer/recorder@ci ;;
    yarn)
        cat >.yarnrc.yml <<YAML
nodeLinker: pnp
enableScripts: false
enableGlobalCache: false
# Yarn holds back versions under a day old; these are seconds old.
npmScopes: { handy-computer: { npmRegistryServer: "$registry", npmMinimalAgeGate: 0 } }
unsafeHttpWhitelist: [localhost]
YAML
        touch yarn.lock
        npx --yes -p @yarnpkg/cli-dist@4 yarn add @handy-computer/recorder@ci
        ;;
    *)
        echo "unknown installer $installer" >&2
        exit 2
        ;;
esac
