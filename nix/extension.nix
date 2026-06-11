# Builds the VSIX for this extension as a Nix package, so it can be consumed as
# a flake input by a home-manager VSCodium config. Two npm projects (root +
# webview) → two buildNpmPackage derivations: the webview is built first and its
# dist is injected into the extension build, which then runs webpack + vsce.
{ lib
, buildNpmPackage
, vsce
, nodejs
, jq
}:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);

  src = lib.cleanSourceWith {
    src = ../.;
    # Keep the build pure and the source hash stable: drop build outputs and the
    # local nix scratch dir so editing them never forces a rebuild.
    filter = path: type:
      let rel = lib.removePrefix (toString ../. + "/") (toString path);
      in !(lib.hasPrefix "dist" rel
        || lib.hasPrefix "webview/dist" rel
        || lib.hasPrefix "node_modules" rel
        || lib.hasPrefix "webview/node_modules" rel
        || lib.hasSuffix ".vsix" rel);
  };

  webview = buildNpmPackage {
    pname = "${manifest.name}-webview";
    inherit (manifest) version;
    inherit src;
    sourceRoot = "source/webview";
    npmDepsHash = "sha256-eWS/HK+QHOIK/LDxl+TP9fJn1/99XaBanP2h+ZnVr8c=";
    inherit nodejs;

    # `npm run build` = `tsc -b && vite build` → ./dist
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
buildNpmPackage {
  pname = manifest.name;
  inherit (manifest) version;
  inherit src;
  npmDepsHash = "sha256-rWzMyHPiWFSS/w7teUQbauaoDT+XdUfYEng/g3YIsNQ=";
  inherit nodejs;

  nativeBuildInputs = [ vsce jq ];

  # The root `install` lifecycle script does `cd webview && npm install`, which
  # would hit the network inside the sandbox. We supply the webview build
  # ourselves, so neutralise it.
  npmFlags = [ "--ignore-scripts" ];

  # The default npm build phase runs `npm run build`, whose root `build` script
  # re-enters webview and reruns its vite build against a non-existent
  # node_modules. Suppress it and drive the build ourselves below.
  dontNpmBuild = true;

  # Drop in the prebuilt webview dist, then webpack the extension. We bypass the
  # `package` npm script (it re-runs the webview vite build) and invoke webpack
  # directly against the dist we already have.
  buildPhase = ''
    runHook preBuild
    mkdir -p webview/dist
    cp -r ${webview}/* webview/dist/
    ./node_modules/.bin/webpack --mode production --devtool hidden-source-map
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    # vsce runs the `vscode:prepublish` script, which re-triggers the full webview
    # vite build against a node_modules that isn't here. Everything is already
    # built, so drop the hook before packaging.
    jq 'del(.scripts."vscode:prepublish")' package.json > package.json.tmp
    mv package.json.tmp package.json
    vsce package --no-dependencies --out $out/${manifest.name}-${manifest.version}.vsix
    runHook postInstall
  '';

  meta = {
    description = manifest.description;
    homepage = manifest.repository.url;
    license = lib.licenses.mit;
  };
}
