// Evaluated in the global scope before the probe driver runs, replacing the game-facing
// api with tests/js/fake-api.js (which the mod picks up through its AUTODRILL_API_FAKE hook).

// Optional scenario: lets a probe describe the world (size, ore shape, settings) it needs.
var scenarioFile = java.nio.file.Paths.get("tests/js/scenario.js");
if(java.nio.file.Files.exists(scenarioFile)){
    var scenarioSource = new java.lang.String(java.nio.file.Files.readAllBytes(scenarioFile), "UTF-8");
    eval(String(scenarioSource));
}

var probeSource = new java.lang.String(
    java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("tests/js/fake-api.js")), "UTF-8");
eval(String(probeSource));
