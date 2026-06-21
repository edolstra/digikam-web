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
        # (cleanCargoSource alone would drop the .css/.js files).
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          name = "source";
          filter = path: type:
            (pkgs.lib.hasSuffix ".css" path)
            || (pkgs.lib.hasSuffix ".js" path)
            || (pkgs.lib.hasSuffix ".ico" path)
            || (pkgs.lib.hasSuffix ".png" path)
            || (pkgs.lib.hasSuffix ".webmanifest" path)
            || (craneLib.filterCargoSources path type);
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
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ digikam-web ];
          packages = [
            rustToolchain
            pkgs.rust-analyzer
            pkgs.sqlite
            pkgs.curl
            pkgs.jq
          ];
          # `cargo build` in the dev shell embeds these the same way `nix build`
          # does (commonArgs.WEBPGF_PATH), so iterating here picks up the assets.
          WEBPGF_PATH = webpgf;
        };
      });
}
