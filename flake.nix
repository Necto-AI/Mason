{
  description = "mason — an agent runtime for building, connecting and running AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      # Linux x64 is the only platform the release checks run on (docs/release-notes/0.1.0.md). The native halves mason
      # needs — the pi-env daemon and the X11 helper `pi-coding-agent` still pulls in — come inside their npm packages, so
      # a build here needs no network beyond the npm dependency cache.
      systems = [ "x86_64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAll (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = self.packages.${system}.mason;
          mason = pkgs.buildNpmPackage {
            pname = "mason-agent";
            version = (builtins.fromJSON (builtins.readFile ./packages/mason-agent/package.json)).version;

            src = ./.;

            # The floor (engines.node >=26.4.0), not nixpkgs' default. The build itself runs `npm run build`, and the
            # wrapper this produces must be the same Node a stranger gets from npm.
            nodejs = pkgs.nodejs_26;
            npmDepsHash = "sha256-U+ai3Uq8xNozn+hAC0xovtm+sCwOwL6fauwxzNU6qRI=";

            # The shipped layout is `dist/`, and `npm run build` is what writes it: tsc over `bin/`, `scripts/`,
            # `src/` and `evals/`, then the assets and the vendored workspace packages that the compiled imports name.
            npmBuildScript = "build";

            # `pi-env` ships prebuilt daemons: they are dynamically linked and must resolve on NixOS, where there is no
            # /lib64/ld-linux.
            nativeBuildInputs = [
              pkgs.autoPatchelfHook
              pkgs.makeWrapper
            ];
            # `pi-tui`'s X11 helper is the other native module in the tree — still installed as a dependency of
            # `pi-coding-agent` — and it links libxcb, which a Nix system does not have on a default search path.
            buildInputs = [
              pkgs.stdenv.cc.cc.lib
              pkgs.libxcb
            ];


            # The published package is the workspace member, not the repository root: pack its files list, prune the
            # install down to what a consumer needs, and put the hoisted tree beside the code. npm leaves the workspace
            # packages in `node_modules` as symlinks into `packages/`; nothing resolves through them — the compiled
            # imports read the copy `npm run build` vendored into `dist/node_modules` — and a link into a directory that
            # is not there is a broken package, so they are removed.
            installPhase = ''
              runHook preInstall
              packageOut="$out/lib/node_modules/mason-agent"
              mkdir -p "$packageOut"
              ${pkgs.jq}/bin/jq --raw-output '.[0].files | map(.path | select(startswith("node_modules/") | not)) | .[]' \
                < <(npm_config_cache="$HOME/.npm" npm pack --json --dry-run --loglevel=warn --no-foreground-scripts --workspace=mason-agent) \
                | while IFS= read -r file; do
                    mkdir -p "$packageOut/$(dirname "$file")"
                    cp "packages/mason-agent/$file" "$packageOut/$file"
                  done
              npm prune --omit=dev --no-save
              find node_modules -maxdepth 1 -type d -empty -delete
              cp -r node_modules "$packageOut/node_modules"
              rm -f "$packageOut/node_modules/.bin/mason" "$packageOut/node_modules/mason-protocol" "$packageOut/node_modules/mason-client" \
                    "$packageOut/node_modules/mason-agent"
              mkdir -p $out/bin
              makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/mason \
                --add-flags "$packageOut/dist/bin/mason.js"
              runHook postInstall
            '';

            meta = {
              description = "An agent runtime for building, connecting and running AI agents";
              homepage = "https://github.com/Necto-AI/mason";
              license = pkgs.lib.licenses.agpl3Only;
              mainProgram = "mason";
              platforms = [ "x86_64-linux" ];
            };
          };
        }
      );

      devShells = forAll (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.git
              pkgs.fd
              pkgs.ripgrep
              pkgs.sqlite
              pkgs.jq
            ];
            shellHook = ''
              echo "mason dev shell (node $(node --version))"
            '';
          };
        }
      );

      formatter = forAll (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
