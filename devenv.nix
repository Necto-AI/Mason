{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

{
  packages = [
    pkgs.git
    pkgs.nodejs_22
    pkgs.rustc
    pkgs.cargo
    pkgs.fd
    pkgs.ripgrep
    pkgs.sqlite
    pkgs.jq
  ];

  scripts.setup.exec = ''
    set -euo pipefail
    echo "[setup] Installing vendor/pi dependencies..."
    (cd vendor/pi && npm ci --ignore-scripts)
    if [ ! -f vendor/pi/packages/ai/src/providers/data/.manifest.json ]; then
      echo "[setup] Hydrating pi-ai model data..."
      (cd vendor/pi/packages/ai && npm run hydrate-model-data)
    fi
    echo "[setup] Building vendor/pi packages..."
    (cd vendor/pi && npm run build:offline)
    echo "[setup] Building pi-env Rust daemon..."
    (cd vendor/pi/packages/env && npm run build:daemon)
    mkdir -p vendor/pi/packages/env/bin/pi-env-linux-x64
    cp vendor/pi/packages/env/daemon/target/debug/pi-env vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env
    chmod +x vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env
    echo "[setup] Installing root workspace dependencies..."
    npm install
  '';

  scripts.dev.exec = ''
    node --conditions=source --experimental-strip-types src/server/main.ts
  '';

  scripts.build-web.exec = ''
    node scripts/build-web.mjs
  '';

  scripts.test-all.exec = ''
    node --conditions=source --experimental-strip-types --test test/*.test.ts
  '';

  enterShell = ''
    echo "personal-durable-agent dev shell (node $(node --version), cargo $(cargo --version))"
  '';
}
