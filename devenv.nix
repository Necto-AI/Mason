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
    pkgs.fd
    pkgs.ripgrep
    pkgs.sqlite
    pkgs.jq
  ];

  scripts.setup.exec = ''
    bash scripts/setup.sh
  '';

  scripts.dev.exec = ''
    node --experimental-strip-types src/server/main.ts
  '';

  scripts.test-all.exec = ''
    node --experimental-strip-types --test test/*.test.ts
  '';

  enterShell = ''
    echo "mason dev shell (node $(node --version))"
  '';
}
