import rhino.*;
import rhino.module.*;
import rhino.module.provider.*;

import java.io.*;
import java.net.*;
import java.nio.file.*;

/**
 * Loads a script mod exactly the way Mindustry does, but with the settings the iOS
 * build uses: optimization level -1 and Kit.isIos == true.
 *
 *   java -cp Mindustry.jar:rhino.jar:. ScriptHarness <mod-dir> [preScript.js]
 *
 * - global.js is taken from the real game jar (tests/harness/global.js) so module-scope
 *   conflicts with the game's own globals surface here rather than on a phone.
 * - An optional pre-script is evaluated in the global scope first (used by the tests to
 *   install AUTODRILL_API_FAKE).
 * - main.js is wrapped in an IIFE with 'use strict', like Scripts.java does.
 */
public class ScriptHarness{
    public static void main(String[] args) throws Exception{
        // simulate the iOS runtime for Rhino's platform checks
        System.setProperty("java.vm.name", "RoboVM");

        Path mod = Paths.get(args[0]);
        Path scripts = mod.resolve("scripts");
        Path globalFile = Paths.get(args.length > 2 ? args[2] : "global.js");
        String preScript = args.length > 1 && !args[1].equals("-") ? Files.readString(Paths.get(args[1])) : null;

        int failures = 0;

        Context cx = Context.enter();
        // -1 is what the iOS build uses; 9 is a fully compiled class, which is what the desktop
        // build uses. Compiling here catches the constructs Rhino's optimizer rejects (they
        // load fine interpreted and then break the mod on desktop/Android), and the error names
        // the function instead of just the file.
        int level = Integer.getInteger("autodrill.opt", -1);
        cx.setOptimizationLevel(level);
        try{
            Scriptable scope = new ImporterTopLevel(cx);
            // NOTE: no bootstrap 'print' - global.js declares its own consts and Rhino
            // rejects redeclarations in the shared lexical scope (this is exactly the
            // class of bug this harness exists to catch).

            final Path base = scripts;
            ModuleSourceProvider provider = new UrlModuleSourceProvider(null, null){
                @Override
                public ModuleSource loadSource(String moduleId, Scriptable paths, Object validator) throws URISyntaxException{
                    // '<mod>/<script>' form, same as Scripts.ScriptModuleProvider
                    Path file = base.resolve(moduleId + ".js");
                    if(!Files.exists(file)) return null;
                    try{
                        return new ModuleSource(Files.newBufferedReader(file), file.toUri(), base.toUri(), validator);
                    }catch(IOException e){
                        return null;
                    }
                }
            };

            new RequireBuilder()
            .setModuleScriptProvider(new SoftCachingModuleScriptProvider(provider))
            .setSandboxed(true).createRequire(cx, scope).install(scope);

            System.out.println("[harness] loading " + globalFile);
            cx.evaluateString(scope, Files.readString(globalFile), "global.js", 0);

            if(preScript != null){
                System.out.println("[harness] evaluating pre-script " + args[1]);
                cx.evaluateString(scope, preScript, "prescript.js", 0);
            }

            System.out.println("[harness] running main.js");
            String main = Files.readString(scripts.resolve("main.js"));
            cx.evaluateString(scope, "(function(){'use strict';\n" + main + "\n})();", "main.js", 0);

            System.out.println("[harness] done");
        }catch(Throwable t){
            failures++;
            System.out.println("[harness] FAILED: " + t);
            t.printStackTrace(System.out);
        }finally{
            Context.exit();
        }

        System.exit(failures == 0 ? 0 : 1);
    }
}
