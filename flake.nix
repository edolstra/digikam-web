{
  description = "Read-only web backend for browsing a Digikam photo database";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, crane }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default;

        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

        commonArgs = {
          src = craneLib.cleanCargoSource ./.;
          strictDeps = true;
          # rusqlite is built with the `bundled` feature, so no system SQLite
          # or pkg-config is required.
          nativeBuildInputs = [ ];
          buildInputs = [ ];
        };

        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        digikam-browse = craneLib.buildPackage (commonArgs // {
          inherit cargoArtifacts;
        });
      in
      {
        packages.default = digikam-browse;
        packages.digikam-browse = digikam-browse;

        apps.default = flake-utils.lib.mkApp {
          drv = digikam-browse;
          name = "digikam-browse";
        };

        checks = {
          inherit digikam-browse;
          clippy = craneLib.cargoClippy (commonArgs // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- --deny warnings";
          });
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ digikam-browse ];
          packages = [
            rustToolchain
            pkgs.rust-analyzer
            pkgs.sqlite
            pkgs.curl
            pkgs.jq
          ];
        };
      });
}
