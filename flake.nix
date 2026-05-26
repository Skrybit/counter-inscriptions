{
  description = "Counter-Inscriptions — Counterparty MIME-inscription stack (Node API + React UI + cp-server)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";

    # The patched counterparty-server (extra MIME types, 50 MB body limit).
    # During local development, override on the command line with:
    #   nix build --override-input counterparty-core path:../counterparty-core
    counterparty-core.url = "github:Skrybit/counterparty-core/nightly";
    counterparty-core.inputs.nixpkgs.follows = "nixpkgs";
    counterparty-core.inputs.flake-utils.follows = "flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, counterparty-core }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # ── Node.js backend (port 3001) ──
        # Express + PSBT composition + wallet integration. Talks to a local
        # counterparty-server over HTTP.
        backend = pkgs.buildNpmPackage {
          pname = "counter-inscriptions-backend";
          version = "1.0.0";
          src = ./backend;

          npmDepsHash = "sha256-7v0BvjbwA64PW/9h5/U5uT8vNKorGpKIiYw9Zc9d8/I=";

          dontNpmBuild = true;  # no build script in package.json

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/counter-inscriptions-backend $out/bin
            cp -r index.js openapi-spec.yaml node_modules package.json $out/lib/counter-inscriptions-backend/
            # Optional fallback artefact upstream ships.
            [ -d frontend-build-fallback ] && cp -r frontend-build-fallback $out/lib/counter-inscriptions-backend/ || true

            cat > $out/bin/counter-inscriptions-backend <<EOF
            #!${pkgs.runtimeShell}
            exec ${pkgs.nodejs_20}/bin/node $out/lib/counter-inscriptions-backend/index.js "\$@"
            EOF
            chmod +x $out/bin/counter-inscriptions-backend
            runHook postInstall
          '';

          meta = {
            description = "Counter-inscriptions Node backend (Express)";
            mainProgram = "counter-inscriptions-backend";
          };
        };

        # ── React frontend (port 3000 in docker; static artefact here) ──
        # react-scripts build → static bundle in $out/share. Serve via Caddy
        # or nginx; we don't ship a runtime here.
        frontend = pkgs.buildNpmPackage {
          pname = "counter-inscriptions-frontend";
          version = "0.1.0";
          src = ./frontend;

          npmDepsHash = "sha256-TvicvHHoXyZmtRY2hl1kciARFj+R44ziiMwDYGNWa00=";

          # react-scripts pulls TypeScript via peer-dep resolution and the
          # default strict npm install fights it. --legacy-peer-deps relaxes
          # that to npm 6 behaviour (which CRA was built against).
          npmFlags = [ "--legacy-peer-deps" ];

          # CRA build is memory-hungry on large dep trees.
          npmBuildScript = "build";
          NODE_OPTIONS = "--max-old-space-size=4096";
          # CRA fails the build on warnings by default; we don't want a
          # missing-import in an experimental fork to brick CI.
          CI = "false";

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/counter-inscriptions-frontend
            cp -r build/* $out/share/counter-inscriptions-frontend/
            # nginx.conf included so a deployer can crib the rewrite rules.
            cp ../nginx.conf $out/share/counter-inscriptions-frontend/nginx.conf.example 2>/dev/null || \
              cp nginx.conf $out/share/counter-inscriptions-frontend/nginx.conf.example 2>/dev/null || true
            runHook postInstall
          '';

          meta.description = "Counter-inscriptions React frontend (static build)";
        };

        # ── Counterparty server (re-exported from the input flake) ──
        # The build-time patches (extra MIME types, 50 MB body/form limits)
        # live in the counterparty-core fork; we just point at the artifact.
        counterparty-server = counterparty-core.packages.${system}.default;
      in
      {
        packages = {
          inherit backend frontend counterparty-server;
          # `default` = the binary you'd most want to test in a shell. The
          # other two are libraries-shaped outputs (Node runtime / static
          # bundle), useful from NixOS modules but less useful as `nix run`.
          default = counterparty-server;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_20
            # Match the cp-server flake's dev tooling.
            python313
            rustc
            cargo
          ];
        };
      }
    );
}
