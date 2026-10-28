// Lint gate for the mod's scripts. Rhino runs the mod strictly ('use strict'), so an
// undeclared assignment throws at runtime on iOS - this must never reach a device.
// NOTE: ESLint's default parser needs ES5/ES2018-ish syntax support only; the mod uses
// classic function/var style on purpose (Rhino's interpreter).
export default [
    {
        files: ["scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: "script",
            globals: {
                Packages: "readonly",
                java: "readonly",
                require: "readonly",
                exports: "readonly",
                modName: "readonly",
                AUTODRILL_API_FAKE: "readonly"
            }
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": ["error", {args: "none", caughtErrors: "none"}],
            "no-redeclare": "error",
            "no-fallthrough": "error",
            "no-constant-condition": "warn",
            "eqeqeq": ["error", "smart"]
        }
    },
    {
        files: ["tests/ingame/**/*.js"],
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: "script",
            globals: {
                Packages: "readonly",
                java: "readonly",
                require: "readonly",
                exports: "readonly"
            }
        },
        rules: {
            "no-undef": "error",
            "no-redeclare": "error"
        }
    }
];
