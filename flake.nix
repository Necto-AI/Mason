{
  description = "mason — an agent runtime for building, connecting and running AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      # Linux x64 is the only platform the release checks run on (docs/release-notes/0.1.0.md). The two native halves
      # mason needs — the renderer's `.so` through node:ffi, and the pi-env daemon — come inside their npm packages, so
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
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

            src = ./.;

            # The floor (engines.node >=26.4.0), not nixpkgs' default. The build itself runs `npm run build`, and the
            # wrapper this produces must be the same Node a stranger gets from npm.
            nodejs = pkgs.nodejs_26;
            npmDepsHash = "sha256-VS6xEGCCvcpWT0NcMkJ/vcgchx49wrGQkxZ3cp0fXKI=";

            # The shipped layout is `dist/`, and `npm run build` is what writes it: tsc over `bin/`, `scripts/`,
            # `src/` and `evals/`, then the assets and the vendored workspace packages that the compiled imports name.
            npmBuildScript = "build";

            # `node:ffi` dlopens the renderer's platform library and `pi-env` ships prebuilt daemons; both are
            # dynamically linked and both must resolve on NixOS, where there is no /lib64/ld-linux.
            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            # `pi-tui`'s X11 helper is the second native module in the tree: it links libxcb, which a Nix system does
            # not have on a default search path.
            buildInputs = [
              pkgs.stdenv.cc.cc.lib
              pkgs.libxcb
            ];


            # npm leaves the two workspace packages in the root's node_modules as symlinks into `packages/`, which the
            # published files list does not carry. Nothing resolves through them — the compiled imports read the copy
            # `npm run build` vendored into `dist/node_modules` — and a link into a directory that is not there is a
            # broken package. The npm tarball has no such links.
            preFixup = ''
              rm -f $out/lib/node_modules/mason-agent/node_modules/mason-protocol \
                    $out/lib/node_modules/mason-agent/node_modules/mason-connector
            '';

            meta = {
              description = "An agent runtime for building, connecting and running AI agents";
              homepage = "https://github.com/DenisSud/mason";
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
