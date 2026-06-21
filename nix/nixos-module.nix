# NixOS module exposed as `nixosModules.default` from flake.nix. Closes over
# `self` so it can resolve this flake's build for the host system.
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.digikam-web;
in
{
  options.services.digikam-web = {
    enable = lib.mkEnableOption "the read-only Digikam photo web backend";

    user = lib.mkOption {
      type = lib.types.str;
      description = ''
        User to run the service as. The Digikam database is read from this
        user's `~/.local/share/digikam/db/digikam4.db` by default.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "TCP port to listen on (bound to 127.0.0.1).";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.digikam-web = {
      description = "Read-only web backend for browsing the Digikam photo database";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${self.packages.${pkgs.stdenv.hostPlatform.system}.digikam-web}/bin/digikam-web --listen 127.0.0.1:${toString cfg.port}";
        User = cfg.user;
        Group = "users";
        Restart = "on-failure";
      };
    };
  };
}
