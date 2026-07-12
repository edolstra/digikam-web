{
  description = "Read-only web backend for browsing a Digikam photo database";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2605.tar.gz";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, crane }:
    {
      # System-agnostic NixOS module (the per-system outputs are merged in below).
      nixosModules.default = import ./nix/nixos-module.nix self;
      nixosModules.digikam-web = self.nixosModules.default;
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default;

        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

        # Keep Cargo sources plus the web assets that `include_str!` pulls in
        # (cleanCargoSource alone would drop the .css/.js files). The Playwright
        # e2e suite is excluded: its .js files would otherwise churn the Rust
        # build on every spec edit (it gets its own store copy in checks.e2e).
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          name = "source";
          filter = path: type:
            !(pkgs.lib.hasInfix "/tests/e2e" path)
            && ((pkgs.lib.hasSuffix ".css" path)
              || (pkgs.lib.hasSuffix ".js" path)
              || (pkgs.lib.hasSuffix ".ico" path)
              || (pkgs.lib.hasSuffix ".png" path)
              || (pkgs.lib.hasSuffix ".webmanifest" path)
              || (craneLib.filterCargoSources path type));
        };

        # WebAssembly PGF thumbnail decoder (built from haplo/webpgf). Its
        # `webpgf.{js,wasm}` are embedded into the binary via `include_bytes!`,
        # so WEBPGF_PATH must point at this output at compile time — set it both
        # for the crane build (commonArgs) and in the dev shell below.
        webpgf = pkgs.callPackage ./nix/webpgf.nix { };

        commonArgs = {
          inherit src;
          strictDeps = true;
          # rusqlite is built with the `bundled` feature, so no system SQLite
          # or pkg-config is required.
          nativeBuildInputs = [ ];
          buildInputs = [ ];
          WEBPGF_PATH = webpgf;
        };

        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        digikam-web = craneLib.buildPackage (commonArgs // {
          inherit cargoArtifacts;
        });
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
          clippy = craneLib.cargoClippy (commonArgs // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- --deny warnings";
          });
          # Playwright e2e suite (tests/e2e): drives the real server — seeded
          # via --seed-fixture — with headless Chromium. playwright-test and
          # playwright-driver.browsers-chromium come from the same nixpkgs, so
          # the runner and browser versions always match.
          e2e = pkgs.runCommand "digikam-web-e2e" {
            nativeBuildInputs = [ digikam-web pkgs.playwright-test pkgs.nodejs ];
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            # Chromium wants a fontconfig config even though the pages under
            # test don't care which fonts exist.
            FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ ]; };
          } ''
            export HOME=$TMPDIR
            cp -r ${./tests/e2e} e2e
            chmod -R u+w e2e
            cd e2e
            # Makes require('@playwright/test') in the config/specs resolve.
            ln -s ${pkgs.playwright-test}/lib/node_modules node_modules
            playwright test
            touch $out
          '';
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ digikam-web ];
          packages = [
            rustToolchain
            pkgs.rust-analyzer
            pkgs.sqlite
            pkgs.curl
            pkgs.jq
            pkgs.python3
            pkgs.nodejs
            pkgs.playwright-test
          ];
          # `cargo build` in the dev shell embeds these the same way `nix build`
          # does (commonArgs.WEBPGF_PATH), so iterating here picks up the assets.
          WEBPGF_PATH = webpgf;
          # Playwright e2e tests against a local build (see tests/e2e/):
          #   cargo build && DIGIKAM_WEB_BIN=target/debug/digikam-web playwright test -c tests/e2e
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          NODE_PATH = "${pkgs.playwright-test}/lib/node_modules";
        };
      });
}
