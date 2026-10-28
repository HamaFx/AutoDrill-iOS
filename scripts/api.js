// AutoDrill (iOS) - api.js
// The single module that talks to Mindustry / Java. Everything else is plain JavaScript,
// which keeps the placement logic testable and keeps every iOS-risky pattern
// (interface implementations, field access on Java objects) in one reviewed place.
//
// iOS rules obeyed here: interfaces may be implemented (single method via function,
// multiple methods via an object literal); classes may never be subclassed.

"use strict";

// Sprites of a mod are packed as "<internal mod name>-<file>". The global `modName`
// is only correct while this mod's own scripts are being loaded, so the name is
// pinned here and the global is merely a fallback for renamed forks.
var SPRITE_PREFIX = "auto-drill-ios-";

function buildReal(){
    var V = Packages.mindustry.Vars;
    var Core = Packages.arc.Core;
    var Blocks = Packages.mindustry.content.Blocks;
    var Build = Packages.mindustry.world.Build;
    var Edges = Packages.mindustry.world.Edges;
    var BuildPlan = Packages.mindustry.entities.units.BuildPlan;
    var Point2 = Packages.arc.math.geom.Point2;
    var Seq = Packages.arc.struct.Seq;
    var Log = Packages.arc.util.Log;
    var Time = Packages.arc.util.Time;
    var Events = Packages.arc.Events;
    var EventType = Packages.mindustry.game.EventType;
    var Table = Packages.arc.scene.ui.layout.Table;
    var ScrollPane = Packages.arc.scene.ui.ScrollPane;
    var TextureRegionDrawable = Packages.arc.scene.style.TextureRegionDrawable;
    var Styles = Packages.mindustry.ui.Styles;
    var Icon = Packages.mindustry.gen.Icon;
    var Pal = Packages.mindustry.graphics.Pal;
    var Align = Packages.arc.util.Align;
    var Scaling = Packages.arc.util.Scaling;
    var KeyCode = Packages.arc.input.KeyCode;
    var InputProcessor = Packages.arc.input.InputProcessor;
    var BaseDialog = Packages.mindustry.ui.dialogs.BaseDialog;
    var SettingsMenuDialog = Packages.mindustry.ui.dialogs.SettingsMenuDialog;
    var Fx = Packages.mindustry.content.Fx;
    var Cons = Packages.arc.func.Cons;
    var Boolp = Packages.arc.func.Boolp;

    var api = {};

    // ---------------------------------------------------------------- logging

    api.log = function(msg){
        Log.info("[auto-drill-ios] " + msg);
    };

    api.bundle = function(key){
        return Core.bundle.get(key);
    };

    api.toast = function(text){
        try{
            V.ui.hudfrag.showToast(text);
        }catch(e){
            api.log(text);
        }
    };

    api.modLoaded = function(name){
        return V.mods.locateMod(name) != null;
    };

    api.warn = function(msg){
        Log.warn("[auto-drill-ios] " + msg);
    };

    /** Appends a line to <data dir>/autodrill-trace.txt. Debug helper: it survives a
     *  hard crash (unlike the log), which makes it usable for bisecting failures. */
    api.trace = function(text){
        try{
            Core.settings.getDataDirectory().child("autodrill-trace.txt").writeString(text + "\n", true);
        }catch(e){
            // tracing must never break the mod
        }
    };

    api.now = function(){
        return Time.millis();
    };

    api.tilesize = function(){
        return V.tilesize;
    };

    // ------------------------------------------------------------ world access

    api.tile = function(x, y){
        return V.world.tile(x, y);
    };

    api.nearby = function(tile, dx, dy){
        return tile == null ? null : tile.nearby(dx, dy);
    };

    api.pos = function(tile){
        return tile.pos();
    };

    api.tx = function(tile){
        return tile.x;
    };

    api.ty = function(tile){
        return tile.y;
    };

    api.worldW = function(){
        return V.world.width();
    };

    api.worldH = function(){
        return V.world.height();
    };

    api.drop = function(tile){
        return tile.drop();
    };

    api.wallDrop = function(tile){
        return tile.wallDrop();
    };

    api.solid = function(tile){
        return tile.solid();
    };

    api.blockOf = function(tile){
        return tile.block();
    };

    api.buildOf = function(tile){
        return tile.build;
    };

    api.relativeTo = function(tile, other){
        return tile.relativeTo(other);
    };

    api.centerXTile = function(tile){
        return tile.centerX();
    };

    api.centerYTile = function(tile){
        return tile.centerY();
    };

    api.dst2ToPoint = function(tile, px, py){
        return tile.dst2(px, py);
    };

    api.dstToPoint = function(tile, px, py){
        return tile.dst(px, py);
    };

    api.tileWorldX = function(tile){
        return tile.worldx();
    };

    api.tileWorldY = function(tile){
        return tile.worldy();
    };

    api.dst2ToTile = function(tile, other){
        return tile.dst2(other.worldx(), other.worldy());
    };

    api.dstToTile = function(tile, other){
        return tile.dst(other.worldx(), other.worldy());
    };

    // ------------------------------------------------------------ content / blocks

    var blockCache = {};

    api.block = function(name){
        if(blockCache[name] === undefined) blockCache[name] = Blocks[name];
        return blockCache[name];
    };

    api.blockId = function(block){
        return block == null ? -1 : block.id;
    };

    api.blockName = function(block){
        return block == null ? "null" : block.name;
    };

    api.size = function(block){
        return block.size;
    };

    api.environmentBuildable = function(block){
        return block.environmentBuildable();
    };

    api.itemId = function(item){
        return item == null ? -1 : item.id;
    };

    api.itemHardness = function(item){
        return item == null ? -1 : item.hardness;
    };

    api.itemLowPriority = function(item){
        return item != null && item.lowPriority;
    };

    api.canMine = function(drill, tile){
        return drill.canMine(tile);
    };

    api.getDrop = function(drill, tile){
        return drill.getDrop(tile);
    };

    api.beamRange = function(drill){
        return drill.range;
    };

    api.beamTier = function(drill){
        return drill.tier;
    };

    api.blockItemDrop = function(block){
        return block == null ? null : block.itemDrop;
    };

    // ------------------------------------------------------------ placement

    api.validPlace = function(block, team, x, y, rot){
        return Build.validPlace(block, team, x, y, rot);
    };

    api.team = function(){
        return V.player.team();
    };

    api.edges = function(size){
        var arr = Edges.getEdges(size);
        var out = [];
        for(var i = 0; i < arr.length; i++){
            out.push({x: arr[i].x, y: arr[i].y});
        }
        return out;
    };

    // One scratch Seq is reused: allocating a Seq per call was a measurable part of the
    // ore-counting cost (the game is single threaded, so sharing is safe).
    var linkedScratch = null;

    api.linkedTiles = function(block, tile){
        if(linkedScratch == null) linkedScratch = new Seq();
        linkedScratch.clear();
        tile.getLinkedTilesAs(block, linkedScratch);

        var out = [];
        for(var i = 0; i < linkedScratch.size; i++){
            out.push(linkedScratch.get(i));
        }
        return out;
    };

    api.newPlan = function(x, y, rot, block, configX, configY){
        if(configX == null){
            return new BuildPlan(x, y, rot, block);
        }
        return new BuildPlan(x, y, rot, block, new Point2(configX, configY));
    };

    api.addPlan = function(plan){
        if(V.player == null || V.player.dead()) return false;
        var unit = V.player.unit();
        if(unit == null) return false;
        unit.addBuild(plan);
        return true;
    };

    // ------------------------------------------------------------ settings

    api.settingInt = function(key, def){
        return Core.settings.getInt(key, def);
    };

    api.settingBool = function(key, def){
        return Core.settings.getBool(key, def);
    };

    api.settingString = function(key, def){
        return Core.settings.getString(key, def);
    };

    api.putSetting = function(key, value){
        Core.settings.put(key, value);
    };

    // ------------------------------------------------------------ sprites / styles

    api.drawable = function(name){
        return new TextureRegionDrawable(Core.atlas.find(name));
    };

    api.hasSprite = function(name){
        return Core.atlas.has(name);
    };

    api.spritePrefix = function(){
        return SPRITE_PREFIX;
    };

    api.modDrawable = function(name){
        return new TextureRegionDrawable(api.sprite(name));
    };

    api.icon = function(name){
        return Icon[name];
    };

    api.style = function(name){
        return Styles[name];
    };

    api.palGray = function(){
        return Pal.gray;
    };

    api.alignBottom = function(){
        return Align.bottom;
    };

    api.scalingFit = function(){
        return Scaling.fit;
    };

    api.sceneWidth = function(){
        return Core.scene.getWidth();
    };

    // ------------------------------------------------------------ events / input

    api.onClientLoad = function(fn){
        Events.on(EventType.ClientLoadEvent, new Cons({get: function(e){
            fn();
        }}));
    };

    api.onTapTile = function(fn){
        Events.on(EventType.TapEvent, new Cons({get: function(event){
            fn(event.tile);
        }}));
    };

    function fullInputProcessor(handlers){
        return new InputProcessor({
            keyDown: handlers.keyDown == null ? function(k){ return false; } : handlers.keyDown,
            keyUp: function(k){ return false; },
            keyTyped: function(c){ return false; },
            touchDown: handlers.touchDown == null ? function(x, y, p, b){ return false; } : handlers.touchDown,
            touchUp: function(x, y, p, b){ return false; },
            touchDragged: function(x, y, p){ return false; },
            mouseMoved: function(x, y){ return false; },
            scrolled: function(ax, ay){ return false; }
        });
    }

    api.addInputProcessor = function(handlers){
        Core.input.addProcessor(fullInputProcessor(handlers));
    };

    /** Forgiving lookup: Arc's KeyCode constants are lower-case enum names ("h"), while
     *  settings written by the Java mod store the upper-case name. */
    api.keyCodeByName = function(name){
        var text = String(name);
        var candidates = [text, text.toLowerCase(), text.toUpperCase()];
        for(var i = 0; i < candidates.length; i++){
            try{
                var code = KeyCode.valueOf(candidates[i]);
                if(code != null) return code;
            }catch(e){
                // try the next spelling
            }
        }
        return null;
    };

    api.keyCodeOrdinal = function(keyCode){
        return keyCode == null ? -1 : keyCode.ordinal();
    };

    api.keyCodeName = function(keyCode){
        return keyCode == null ? "" : keyCode.name();
    };

    api.sceneHasKeyboard = function(){
        return Core.scene.hasKeyboard();
    };

    api.isMenu = function(){
        return V.state.isMenu();
    };

    api.uiBlockingShown = function(){
        return V.ui.chatfrag.shown() || V.ui.schematics.isShown() || V.ui.database.isShown()
            || V.ui.consolefrag.shown() || V.ui.content.isShown();
    };

    api.cameraProject = function(x, y){
        var v = Core.camera.project(x, y);
        return {x: v.x, y: v.y};
    };

    /** Tap feedback. Guarded: there is no player in the main menu, and Effect.at
     *  dereferences it. Never let cosmetics break the tool. */
    api.tapFx = function(x, y){
        try{
            if(V.player == null) return;
            Fx.tapBlock.at(x, y);
        }catch(e){
            // ignore - purely cosmetic
        }
    };

    // ------------------------------------------------------------ scene elements

    api.newToolbar = function(){
        return new Table(Styles.black3);
    };

    api.newDirectionTable = function(){
        return new Table(Styles.black3);
    };

    api.toolbarAddButton = function(table, drawable, onClick){
        var cell = table.button(drawable, Styles.defaulti, new java.lang.Runnable({run: onClick}));
        var button = cell.get();
        button.resizeImage(30);
        return button;
    };

    api.directionAddButton = function(table, iconName, onClick){
        var cell = table.button(Icon[iconName], Styles.defaulti, new java.lang.Runnable({run: onClick}));
        var button = cell.get();
        button.resizeImage(30);
        return button;
    };

    api.tableRow = function(table){
        table.row();
    };

    api.tableCell = function(table){
        return table.table().get();
    };

    api.elementRemove = function(table, element){
        table.removeChild(element);
    };

    api.elementSetVisible = function(element, visible){
        element.visible = visible;
    };

    api.elementIsVisible = function(element){
        return element.visible;
    };

    api.elementHasMouse = function(element){
        return element.hasMouse();
    };

    api.elementSetPosition = function(element, x, y){
        element.setPosition(x, y, Align.bottom);
    };

    api.elementUpdate = function(element, fn){
        element.update(new java.lang.Runnable({run: fn}));
    };

    api.elementBounds = function(element){
        return {
            x: Math.round(element.x),
            y: Math.round(element.y),
            w: Math.round(element.getWidth()),
            h: Math.round(element.getHeight()),
            visible: element.visible
        };
    };

    api.elementToFront = function(element){
        element.toFront();
    };

    api.elementAttach = function(element){
        element.pack();
        element.act(0);
        Core.scene.root.addChildAt(0, element);
    };

    api.elementReset = function(element){
        element.pack();
        element.act(0);
    };

    /** Resolves one of this mod's own sprites, tolerating a renamed fork. */
    api.sprite = function(name){
        var prefix = (typeof modName !== "undefined" && modName) ? modName + "-" : "";
        var region = prefix === "" ? null : Core.atlas.find(prefix + name);
        if(region == null || region.width <= 0){
            region = Core.atlas.find(SPRITE_PREFIX + name);
        }
        return region;
    };

    api.hudFill = function(fn){
        V.ui.hudGroup.fill(new Cons({get: function(table){
            fn(table);
        }}));
    };

    api.hudToggleButton = function(drawable, visibleFn, onClick){
        var handle = {setChecked: function(v){}};
        V.ui.hudGroup.fill(new Cons({get: function(t){
            t.margin(5);
            t.marginRight(155);
            t.top().right();
            var cell = t.button(drawable, Styles.emptyTogglei, new java.lang.Runnable({run: onClick}));
            var button = cell.get();
            button.resizeImage(30);
            // NOTE: Element.visible exists as BOTH a field and a method; Rhino always
            // resolves the name to the field, so the Boolp provider must be assigned
            // to the separate 'visibility' field (Group.act applies it every frame).
            button.visibility = new Boolp({get: visibleFn});
            handle.element = button;
            handle.setChecked = function(v){
                button.setChecked(v);
            };
        }}));
        return handle;
    };

    // ------------------------------------------------------------ tutorial dialog

    api.showTutorial = function(){
        var bundle = Core.bundle;
        var dialog = new BaseDialog(bundle.get("auto-drill-welcome-title"));

        // Keep the dialog inside the screen on phones and readable on tablets/destop.
        var maxWidth = Math.min(1000, Math.max(200, Core.scene.getWidth() - 40));

        var t = new Table();
        t.labelWrap(bundle.get("auto-drill-welcome-text")).width(maxWidth).padTop(10).row();
        t.labelWrap(bundle.get("auto-drill-tutorial-text")).width(maxWidth).padTop(10).row();

        function addImage(name){
            var region = api.sprite(name);
            if(region == null || region.width <= 0) return;
            var height = Math.round(maxWidth * (region.height / region.width));
            t.image(new TextureRegionDrawable(region)).size(maxWidth, height).padTop(10).row();
        }

        addImage("tutorial");
        t.labelWrap(bundle.get("auto-drill-tutorial2-text")).width(maxWidth).padTop(10).row();
        addImage("tutorial2");
        t.labelWrap(bundle.get("auto-drill-settings-text")).width(maxWidth).padTop(10).row();
        addImage("settings");
        t.labelWrap(bundle.get("auto-drill-conclusion-text")).width(maxWidth).padTop(10).row();

        dialog.cont.top().add(new ScrollPane(t)).grow().pad(0, 10, 0, 10).maxWidth(maxWidth + 20);
        dialog.addCloseButton();
        dialog.show();
    };

    // ------------------------------------------------------------ settings menu

    api.addSettingsCategory = function(title, drawable, builder){
        var category = new SettingsMenuDialog.SettingsCategory(title, drawable, new Cons({get: function(st){
            // The 7-argument sliderPref overload is the only unambiguous one; the 6-argument
            // forms are ambiguous for a JS function (StringProcessor vs Intc).
            builder({
                slider: function(key, def, min, max, step){
                    st.sliderPref(key, def, min, max, step,
                        new SettingsMenuDialog.StringProcessor({get: function(v){
                            return "" + v;
                        }}), null);
                },
                check: function(key, def){
                    st.checkPref(key, def, null);
                },
                text: function(key, def, onChange){
                    st.textPref(key, def, onChange == null ? null : new Cons({get: function(value){
                        onChange(value);
                    }}));
                }
            });
        }}));
        V.ui.settings.getCategories().add(category);
    };

    return api;
}

var impl = (typeof AUTODRILL_API_FAKE !== "undefined") ? AUTODRILL_API_FAKE : buildReal();

for(var key in impl){
    exports[key] = impl[key];
}
