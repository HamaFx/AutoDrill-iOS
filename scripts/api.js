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
    var Attribute = Packages.mindustry.world.meta.Attribute;
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

    /** Arc Point2.pack(x, y) - how Mindustry stores an item bridge's link target. */
    api.pointPacked = function(x, y){
        return Point2.pack(x, y);
    };

    /** The packed link target of a built item bridge, or -1 when unset. */
    api.bridgeLinkPacked = function(building){
        return building == null ? -1 : building.link;
    };

    /** Water attribute of a tile's floor - decides how good a water extractor would be. */
    api.waterAt = function(tile){
        return tile.floor().attributes.get(Packages.mindustry.world.meta.Attribute.water);
    };

    /** True when something (drill, node, wall) already stands on the tile. */
    api.hasBuilding = function(tile){
        return tile != null && tile.build != null;
    };

    /** Localised name of an item by id, or null when there is no such item. */
    api.itemName = function(id){
        var item = id < 0 ? null : V.content.item(id);
        return item == null ? null : item.localizedName;
    };

    /** True when the tile's floor is water (what a player means by "water here"). */
    api.waterTile = function(tile){
        return tile != null && tile.floor().isLiquid === true;
    };

    /**
     * Erekir sectors are flagged `Env.scorching`; Serpulo's are not. The two planets use
     * completely different blocks for the same jobs (power nodes vs beam nodes/towers,
     * conduits vs reinforced conduits, water extractors vs vent condensers), so the support
     * passes ask this instead of guessing.
     */
    api.isErekir = function(){
        return (V.state.rules.env & Packages.mindustry.game.Env.scorching) !== 0;
    };

    /**
     * Wireless link range of a power block: PowerNode exposes `laserRange`, BeamNode and
     * BeamTower expose `range`. Read at runtime so a game update changing the numbers (v8 moved
     * beam nodes from 5 to 10) needs no mod change.
     */
    api.powerRangeOf = function(block){
        // PowerNode keeps its link range in `laserRange`, BeamNode and BeamTower in `range`.
        // Reading the field the other kind does not have throws on the interpreted engine, so
        // each read is guarded rather than checking the class (which Rhino here will not do).
        if(String(block.name) === "power-node") return Math.floor(block.laserRange);
        return Math.floor(block.range);
    };

    /**
     * Whether a pump placed here would actually produce water. Mindustry's SolidPump works from
     * two sources: standing water under its footprint (`validTiles`) and ground water
     * (`sumAttribute(water)`, which is what the block's own canPlaceOn checks). Dry land has
     * neither, so an extractor there is a dead block - the original placed one anyway.
     */
    api.pumpsWaterAt = function(block, x, y, team){
        var tile = V.world.tile(x, y);
        if(tile == null) return false;

        if(block.canPlaceOn(tile, team, 0)) return true;    // ground water

        var size = api.size(block);
        var offset = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var t = V.world.tile(x - offset + dx, y - offset + dy);
                if(t != null && t.floor().isLiquid === true
                    && t.floor().liquidDrop === Packages.mindustry.content.Liquids.water){
                    return true;
                }
            }
        }
        return false;
    };

    /** How far a power node reaches - links are wireless within this many tiles. */
    api.powerLinkRange = function(){
        return Blocks.powerNode.laserRange;
    };

    /**
     * The power block this environment wires with: beam towers or beam nodes on Erekir, power
     * nodes on Serpulo. Beam towers reach 23 tiles from a 3x3 footprint, so one or two of them
     * power a whole patch - they are preferred when the game has them unlocked and buildable.
     *
     * Returns null when nothing power-related can be built here.
     */
    api.powerSupportInfo = function(){
        var tower = Blocks.beamTower;
        var beam = Blocks.beamNode;
        var node = Blocks.powerNode;

        if(api.isErekir()){
            if(tower != null && tower.environmentBuildable()){
                return {block: tower, range: api.powerRangeOf(tower), size: tower.size,
                    linkBlock: beam != null && beam.environmentBuildable() ? beam : tower};
            }
            if(beam != null && beam.environmentBuildable()){
                return {block: beam, range: api.powerRangeOf(beam), size: beam.size, linkBlock: beam};
            }
        }

        if(node != null && node.environmentBuildable()){
            return {block: node, range: api.powerRangeOf(node), size: node.size, linkBlock: node};
        }
        return null;
    };

    /** The liquid pipe for this environment: conduits, reinforced conduits on Erekir. */
    api.liquidConduit = function(){
        var candidates = [Blocks.conduit, Blocks.reinforcedConduit, Blocks.platedConduit];
        for(var i = 0; i < candidates.length; i++){
            var block = candidates[i];
            if(block != null && block.environmentBuildable()) return block;
        }
        return null;
    };

    /** The water pump for this environment (Erekir pipes water with its own pump). */
    api.pumpBlock = function(){
        var candidates = [Blocks.mechanicalPump, Blocks.impulsePump, Blocks.rotaryPump];
        for(var i = 0; i < candidates.length; i++){
            var block = candidates[i];
            if(block != null && block.environmentBuildable()) return block;
        }
        return null;
    };

    /** Floor attribute of a tile by name: "water", "oil" or "steam". */
    api.attributeAt = function(tile, name){
        var attribute = name === "oil" ? Attribute.oil : (name === "steam" ? Attribute.steam : Attribute.water);
        return tile.floor().attributes.get(attribute);
    };

    /**
     * Nearest existing building that is part of a power grid (a node, battery, generator or
     * consumer - anything whose block carries power), searched outwards from (x, y). Returns
     * null when there is nothing within `radius`, so a fill can leave wiring to the player
     * rather than guessing.
     */
    api.powerTargetNear = function(x, y, radius){
        var best = null, bestDist = 0;

        for(var r = 1; r <= radius; r++){
            for(var dx = -r; dx <= r; dx++){
                for(var dy = -r; dy <= r; dy++){
                    // ring only: the first ring that holds a candidate wins
                    if(Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy) !== r) continue;

                    var t = V.world.tile(x + dx, y + dy);
                    if(t == null || t.build == null) continue;
                    if(!isPowerBlock(t.block())) continue;

                    var d = dx * dx + dy * dy;
                    if(best == null || d < bestDist){
                        best = t;
                        bestDist = d;
                    }
                }
            }
            if(best != null) return best;
        }
        return null;
    };

    /**
     * Whether a block belongs to the power system. `hasPower` alone is not enough: a bare
     * PowerNode does not set it, so the conduit/output/consumer flags are checked too.
     */
    function isPowerBlock(block){
        return block != null && (block.hasPower === true || block.conductivePower === true
            || block.consumesPower === true || block.outputsPower === true);
    }

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

    api.bridgeRange = function(block){
        return block.range;
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

    /** Removes one previously added build plan from the player's queue (undo). */
    api.removePlan = function(plan){
        if(V.player == null || V.player.dead()) return false;
        var unit = V.player.unit();
        if(unit == null) return false;
        return unit.plans.remove(plan, true);
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

    /** Writes an int setting. Arc's Settings.put rejects a boxed Double, which is what a
     *  plain JS number becomes on the way into Java, so the value must be boxed as an int. */
    api.putSettingInt = function(key, value){
        Core.settings.putInt(key, value | 0);
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

    api.sceneHeight = function(){
        return Core.scene.getHeight();
    };

    // ------------------------------------------------------------ events / input

    /** Runs `fn` on the next frame - used to spread long work over frames. */
    api.postStep = function(fn){
        Core.app.post(new java.lang.Runnable({run: fn}));
    };

    // ---- progress bar (the same widget the mod importer uses) ----
    //
    // Took three releases to find: LoadFragment wants a Floatp, and handing it a number passes
    // a Floatp-shaped object whose get() *is* that number. The bar then calls get() while it
    // draws, which throws inside the render loop - on iOS that takes the whole game down, and
    // only the fills that show a progress bar (the optimiser ones) crashed.
    //
    // The value lives here instead; the provider is created once and reads it.
    var progressValue = 0;

    api.showProgress = function(title){
        progressValue = 0;
        V.ui.loadfrag.show(title);
        V.ui.loadfrag.setProgress(new Packages.arc.func.Floatp({
            get: function(){
                return progressValue;
            }
        }));
    };

    /** Sets the progress fraction (0..1). Takes a number, not a function. */
    api.setProgress = function(value){
        progressValue = value;
    };

    api.setProgressCancel = function(fn){
        V.ui.loadfrag.setButton(new java.lang.Runnable({run: fn}));
    };

    api.hideProgress = function(){
        V.ui.loadfrag.hide();
    };

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

    // 44px is the smallest comfortable touch target on a phone; the game's UI scale
    // multiplies this, so it stays proportional on tablets.
    var TOUCH_SIZE = 44;

    api.toolbarAddButton = function(table, drawable, onClick){
        var cell = table.button(drawable, Styles.defaulti, new java.lang.Runnable({run: onClick}));
        var button = cell.get();
        button.resizeImage(TOUCH_SIZE);
        return button;
    };

    api.directionAddButton = function(table, iconName, onClick){
        var cell = table.button(Icon[iconName], Styles.defaulti, new java.lang.Runnable({run: onClick}));
        var button = cell.get();
        button.resizeImage(TOUCH_SIZE);
        return button;
    };

    /** Swaps an existing button's icon (used to turn the cancel button into a confirm tick). */
    api.setButtonIcon = function(button, iconName){
        button.getImage().setDrawable(Icon[iconName]);
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
        // null-guard: a failed init leaves the tables unset, and a broken init must not throw
        // somewhere else entirely (the test rig caught exactly that)
        if(element != null) element.visible = visible;
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
            button.resizeImage(38);
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

    /** A plain (non-toggle) HUD button, e.g. undo. */
    api.hudButton = function(iconName, visibleFn, onClick){
        var handle = {element: null};
        V.ui.hudGroup.fill(new Cons({get: function(t){
            t.margin(5);
            t.marginRight(201);
            t.top().right();
            var cell = t.button(Icon[iconName], Styles.defaulti, new java.lang.Runnable({run: onClick}));
            var button = cell.get();
            button.resizeImage(38);
            button.visibility = new Boolp({get: visibleFn});
            handle.element = button;
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
                slider: function(key, def, min, max, step, format){
                    st.sliderPref(key, def, min, max, step,
                        new SettingsMenuDialog.StringProcessor({get: function(v){
                            return format == null ? "" + v : format(v);
                        }}), null);
                },
                check: function(key, def){
                    st.checkPref(key, def, null);
                },
                text: function(key, def, onChange){
                    st.textPref(key, def, onChange == null ? null : new Cons({get: function(value){
                        onChange(value);
                    }}));
                },
                // Extra rows are appended after the preference list. The settings table
                // rebuilds when a preference is registered, so these must come last.
                label: function(text){
                    st.labelWrap(text).growX().fillX().left().padTop(12).padLeft(8).get().setWrap(true);
                    st.row();
                },
                divider: function(){
                    st.image().growX().pad(8, 0, 8, 0).color(Pal.gray);
                    st.row();
                },
                button: function(text, onClick){
                    st.button(text, new java.lang.Runnable({run: onClick})).size(220, 46).padTop(6);
                    st.row();
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
