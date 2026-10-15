#!/usr/bin/env bash
# Starts a local npm registry (Verdaccio) in the background and publishes the
# packed packages to it, so installing them resolves the platform packages the
# way installing from npm does. Prints the registry's URL.
#
#   local-registry.sh <folder of tarballs> <work dir>
set -euo pipefail

packages=$1
work=$(mkdir -p "$2" && cd "$2" && pwd)
# Git Bash on Windows: paths that npm and Verdaccio understand.
if command -v cygpath >/dev/null; then
    packages=$(cygpath -m "$packages")
    work=$(cygpath -m "$work")
fi
url=http://localhost:4873/

cat >"$work/config.yaml" <<YAML
storage: ./storage
packages:
  "@handy-computer/*": { access: \$all, publish: \$all }
log: { type: stdout, format: pretty, level: warn }
YAML
npx --yes verdaccio@6 --config "$work/config.yaml" --listen 4873 >"$work/verdaccio.log" 2>&1 &
for _ in $(seq 60); do curl -sf "${url}-/ping" >/dev/null && break; sleep 1; done
curl -sf "${url}-/ping" >/dev/null || { cat "$work/verdaccio.log" >&2; exit 1; }

# Verdaccio lets anyone publish here, but npm won't try without a token.
echo "//localhost:4873/:_authToken=local" >"$work/npmrc"
for tarball in "$packages"/*.tgz; do
    npm publish "$tarball" --registry "$url" --userconfig "$work/npmrc" --tag ci >&2
done
echo "$url"
