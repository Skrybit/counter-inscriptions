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

        # ── Deno backend (port 3001) — INFRA-281 / ADR-049 ──
        # Ported from Express/Node to Deno-native (Deno.serve + Request.formData
        # + fetch + @std). Dependencies are the jsr @std libs only, vendored
        # under backend/vendor/ and pinned in deno.lock — so both the build and
        # the runtime resolve fully offline (no npmDepsHash, no network, no
        # node_modules). cp-server dependency is unaffected.
        backend = pkgs.stdenvNoCC.mkDerivation {
          pname = "counter-inscriptions-backend";
          version = "1.0.0";
          src = ./backend;

          nativeBuildInputs = [ pkgs.deno pkgs.makeWrapper ];

          # Build-time validation: type-check offline against the vendored deps.
          # A writable DENO_DIR is needed for Deno's transpile cache; the deps
          # themselves come from vendor/.
          buildPhase = ''
            runHook preBuild
            export DENO_DIR="$TMPDIR/deno-dir"
            export DENO_NO_UPDATE_CHECK=1
            # No network in the sandbox; deno resolves deps from vendor/ + the
            # committed deno.lock. (deno 2.2's `check` has no --cached-only, but
            # it stays offline because everything it needs is vendored.)
            deno check index.ts
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/counter-inscriptions-backend
            cp -r index.ts deno.json deno.lock openapi-spec.yaml vendor \
              $out/lib/counter-inscriptions-backend/
            # Optional fallback artefact upstream ships.
            [ -d frontend-build-fallback ] && \
              cp -r frontend-build-fallback $out/lib/counter-inscriptions-backend/ || true

            # Deno resolves deps from the vendored tree offline (--cached-only);
            # it still wants a writable DENO_DIR for its transpile cache, so
            # default one to a private temp dir when the caller sets none.
            makeWrapper ${pkgs.deno}/bin/deno $out/bin/counter-inscriptions-backend \
              --run 'export DENO_DIR="''${DENO_DIR:-$(mktemp -d -t ci-deno-XXXXXX)}"' \
              --set DENO_NO_UPDATE_CHECK 1 \
              --add-flags "run --cached-only --allow-net --allow-read --allow-env $out/lib/counter-inscriptions-backend/index.ts"
            runHook postInstall
          '';

          meta = {
            description = "Counter-inscriptions Deno backend (Deno.serve)";
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
