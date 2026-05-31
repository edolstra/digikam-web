# Builds the webpgf WebAssembly PGF decoder (https://github.com/haplo/webpgf):
# Emscripten compiles a vendored, patched libpgf (autotools) and links it with
# src/webpgf.cpp into dist/webpgf.{js,wasm}. Output is the `dist/` contents.
{
  stdenv,
  fetchFromGitHub,
  emscripten,
  autoconf,
  automake,
  libtool,
  m4,
  dos2unix,
  pkg-config,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "webpgf";
  version = "0-unstable-2024";

  src = fetchFromGitHub {
    owner = "haplo";
    repo = "webpgf";
    rev = "d98dc450fea4af51dc767af58048e2ff7b541ce0";
    hash = "sha256-kPRyTl68X0zpGLR66iWnfwlCWbOy5gmHJibH7flQWqA=";
  };

  nativeBuildInputs = [
    emscripten
    autoconf
    automake
    libtool
    m4
    dos2unix
    pkg-config
  ];

  # No ./configure at the repo root — the autotools step is libpgf's, driven by
  # the Makefile under emconfigure/emmake.
  dontConfigure = true;

  # Emscripten needs a writable cache; copy the prebuilt sysroot that ships with
  # the nixpkgs emscripten package (no network in the build sandbox).
  preBuild = ''
    export HOME=$TMPDIR
    cp -R ${emscripten}/share/emscripten/cache $TMPDIR/em-cache
    chmod -R u+w $TMPDIR/em-cache
    export EM_CACHE=$TMPDIR/em-cache
  '';

  buildPhase = ''
    runHook preBuild
    make build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp dist/webpgf.js dist/webpgf.wasm $out/
    cp dist/webpgf_debug.js dist/webpgf_debug.wasm $out/
    runHook postInstall
  '';

  meta = {
    description = "WebAssembly PGF image decoder (libpgf via Emscripten)";
    homepage = "https://github.com/haplo/webpgf";
  };
})
