// Evaluated in the global scope before the probe driver runs, replacing the game-facing
// api with tests/js/fake-api.js (which the mod picks up through its AUTODRILL_API_FAKE hook).

var probeSource = new java.lang.String(
    java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("tests/js/fake-api.js")), "UTF-8");
eval(String(probeSource));
