{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/549bd84d6279f9852cae6225e372cc67fb91a4c1";
    flake-utils.url = "github:numtide/flake-utils/11707dc2f618dd54ca8739b309ec4fc024de578b";
    v_flakes.url = "github:valeratrades/v_flakes/d4737aa179386874334cb1b2b21f174d11957fc4";
  };

  outputs = { self, nixpkgs, flake-utils, v_flakes }:
    let
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      pname = manifest.name;
    in
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; };

          # This repo is a fork of excalidraw/excalidraw-vscode. We don't adopt
          # the full v_flakes CI rewrite (enable = false), only the standalone
          # sync_fork workflow that rebases our fork over upstream daily. Its
          # shellHook writes ./.github/workflows/sync_fork.yml on every rebuild.
          github = v_flakes.github {
            inherit pkgs pname;
            enable = false;
            syncFork = true;
          };

          # `.gitattributes` with lfs = false: marks binary-ish files (*.png,
          # *.svg, *.excalidraw, ...) as `-filter` so git stops emitting spurious
          # text diffs on them, and `merge=ours` on *.excalidraw/*.pdf so a
          # conflict keeps the current branch's version. The `ours` driver is
          # registered below (the github module only does this when enable=true).
          gitattributes = v_flakes.files.gitattributes { inherit pkgs; lfs = false; };
        in
        {
          devShells.default = with pkgs; mkShell {
            shellHook = (v_flakes.utils.unwrapShellHook github.shellHook) + ''
              #cp -f ${gitattributes} ./.gitattributes # here specifically can't, as I always git-lfs .excalidraw files
              git config merge.ours.driver true
            '';

            packages = [
              nodejs
            ] ++ github.enabledPackages;
          };
        }
      );
}
