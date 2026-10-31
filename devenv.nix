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
    bash scripts/setup.sh
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
    echo "mason dev shell (node $(node --version), cargo $(cargo --version))"
  '';
}
