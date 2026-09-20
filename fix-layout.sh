#!/usr/bin/env bash
set -euo pipefail
[ -d "packages " ] && git mv "packages " packages_tmp && git mv packages_tmp packages
for d in core node protocol crypto wallet; do
  [ -d "packages/$d " ] && git mv "packages/$d " "packages/${d}_tmp" && git mv "packages/${d}_tmp" "packages/$d"
done
if [ -d "packages/ protocol " ]; then
  mkdir -p packages/protocol/src
  for f in "packages/ protocol /  src/"*; do git mv "$f" "packages/protocol/src/$(basename "$f")"; done
fi
for p in core node protocol crypto wallet; do
  [ -d "packages/$p/src " ] && git mv "packages/$p/src " "packages/$p/src_tmp" && git mv "packages/$p/src_tmp" "packages/$p/src"
done
[ -d "packages/wallet/src/ api" ] && git mv "packages/wallet/src/ api" packages/wallet/src/api_tmp && git mv packages/wallet/src/api_tmp packages/wallet/src/api
[ -d "packages/wallet/src/api " ] && git mv "packages/wallet/src/api " packages/wallet/src/api_tmp && git mv packages/wallet/src/api_tmp packages/wallet/src/api
git ls-files | grep ' ' || echo "clean: no odd names left"
