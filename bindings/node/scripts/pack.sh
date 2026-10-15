#!/usr/bin/env bash
# Packs what we publish, from the binaries in prebuilds/: a package per
# platform holding that platform's binary, and the main package, which lists
# them all as optional dependencies. Each platform package declares its os,
# cpu, and libc, so package managers install only the one that fits.
#
#   scripts/pack.sh <output dir>
set -euo pipefail

out=$(mkdir -p "$1" && cd "$1" && pwd)
cd "$(dirname "$0")/.."

# package.json gets the optional dependencies only in the packed copy.
cp package.json "$out/.package.json"
trap 'mv "$out/.package.json" package.json' EXIT

rm -rf npm
npx napi create-npm-dirs >/dev/null
version=$(node -p 'require("./package.json").version')
for dir in npm/*/; do
    cp "prebuilds/recorder.$(basename "$dir").node" LICENSE "$dir"
    npm pkg set "optionalDependencies.$(cd "$dir" && npm pkg get name | tr -d '"')=$version"
    npm pack "$dir" --pack-destination "$out"
done
npm pack --pack-destination "$out"
