#!/bin/zsh
set -e
cd "${0:A:h:h}"
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      export PATH="${candidate:h}:$PATH"
    fi
  done
fi
exec node bridge/server.mjs
