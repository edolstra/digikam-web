{
  description = "Read-only web backend for browsing a Digikam photo database";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2605.tar.gz";
    flake-utils.url = "github:numtide/flake-utils";
    # Builds the crate graph with one derivation per crate. Evaluating it needs
    # Determinate Nix with the `wasm-builtin` experimental feature.
    increments-rust.url = "https://flakehub.com/f/DeterminateSystems/increments-rust/0.1";
  };

  outputs = { self, nixpkgs, flake-utils, increments-rust }:
    {
      # System-agnostic NixOS module (the per-system outputs are merged in below).
      nixosModules.default = import ./nix/nixos-module.nix self;
      nixosModules.digikam-web = self.nixosModules.default;
    }
    # Only x86_64-linux is built and tested.
    // flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ increments-rust.overlays.default ];
        };
        inherit (pkgs) lib;

        # WebAssembly PGF thumbnail decoder (built from haplo/webpgf). Its
        # `webpgf.{js,wasm}` are embedded into the binary via `include_bytes!`,
        # so WEBPGF_PATH must point at this output at compile time — set it both
        # for the crate build (crateOverrides) and in the dev shell below.
        webpgf = pkgs.callPackage ./nix/webpgf.nix { };

        # One derivation per crate (increments-rust); the build graph is
        # computed at evaluation time from Cargo.lock and the manifests.
        workspace = pkgs.increments.rust.buildCargoWorkspace {
          src = ./.;
          # What our own crate is compiled from: the Cargo files and src/,
          # which also holds every asset that `include_str!`/`include_bytes!`
          # embeds. Leaving out the rest (the e2e specs, docs, nix/) keeps
          # edits there from rebuilding the crate.
          localSource = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./src ];
          };
          # rusqlite is built with the `bundled` feature, so no system SQLite
          # is required.
          crateOverrides.digikam-web.env.WEBPGF_PATH = "${webpgf}";
        };

        digikam-web = workspace.packages.digikam-web;
      in
      {
        packages.default = digikam-web;
        packages.digikam-web = digikam-web;
        packages.webpgf = webpgf;

        apps.default = flake-utils.lib.mkApp {
          drv = digikam-web;
          name = "digikam-web";
        };

        checks = {
          inherit digikam-web;
          # The crate's unit and API integration tests (`cargo test`).
          tests = workspace.tests.digikam-web;
          # Playwright e2e suite (tests/e2e): drives the real server — seeded
          # via --seed-fixture — with headless Chromium. playwright-test and
          # playwright-driver.browsers-chromium come from the same nixpkgs, so
          # the runner and browser versions always match.
          e2e = pkgs.runCommand "digikam-web-e2e" {
            nativeBuildInputs = [ digikam-web pkgs.playwright-test pkgs.nodejs ];
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            # Real fonts, so the stage screenshots (below) have legible text
            # instead of tofu boxes.
            FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          } ''
            export HOME=$TMPDIR
            cp -r ${./tests/e2e} e2e
            chmod -R u+w e2e
            cd e2e
            # Makes require('@playwright/test') in the config/specs resolve.
            ln -s ${pkgs.playwright-test}/lib/node_modules node_modules
            # $out is a directory of per-stage screenshots for human review:
            # `nix build .#checks.<system>.e2e` leaves them under ./result.
            mkdir $out
            export E2E_SCREENSHOT_DIR=$out
            playwright test
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.rustc
            pkgs.cargo
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            pkgs.sqlite
            pkgs.curl
            pkgs.jq
            pkgs.python3
            pkgs.nodejs
            pkgs.playwright-test
          ];
          # `cargo build` in the dev shell embeds these the same way `nix build`
          # does (the crateOverrides above), so iterating here picks up the assets.
          WEBPGF_PATH = webpgf;
          # The standard library's source, for rust-analyzer.
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          # Playwright e2e tests against a local build (see tests/e2e/):
          #   cargo build && DIGIKAM_WEB_BIN=target/debug/digikam-web playwright test -c tests/e2e
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          NODE_PATH = "${pkgs.playwright-test}/lib/node_modules";
        };
      });
}
