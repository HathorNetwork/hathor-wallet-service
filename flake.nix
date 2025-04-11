{
  description = "virtual environments";

  inputs = {
    devshell.url = "github:numtide/devshell";
    flake-utils.url = "github:numtide/flake-utils";
    unstableNixPkgs.url = "nixpkgs/nixos-unstable";
  };

  outputs = { self, flake-utils, devshell, nixpkgs, unstableNixPkgs, ... }@inputs:
    let
      overlays.default = final: prev:
        let
          packages = self.packages.${final.system};
          inherit (packages) nodePackages;
        in
        {
          nodejs = final.nodejs_22;
          nodePackages = prev.nodePackages;
          yarn = (import unstableNixPkgs { system = final.system; }).yarn-berry;
        };
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            devshell.overlays.default
            overlays.default
          ];
        };
      in
      {
        devShell = pkgs.devshell.mkShell {
          packages = with pkgs; [
            nixpkgs-fmt
            nodejs_22
            yarn
            docker-compose
          ];
          devshell = {
            startup = {
              setup.text = ''
                export PATH="$PWD/node_modules/.bin:$PWD/packages/daemon/node_modules/.bin:$PWD/packages/wallet-service/node_modules/.bin:$PATH"
              '';
            };
          };
        };
      }
    );
}
