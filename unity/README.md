# Muchi Issen — Unity game frontend

Open this folder with Unity **2022.3.62f1** (Built-in Render Pipeline). In Unity choose **Muchi → Create Frontend Scene**, then Play. The generated scene is added to Build Settings. Runtime bootstrap also supports an empty scene.

## Screen flow

Title → tutorial race → partner naming → one-time free scout → home. Home links to stable details, jockey wardrobe, course looks, care/feed, private-room conditions, scout, store, season pass, race entry, ranked race, and result. The screen layouts use full-screen 16:9 art, compact navy overlays, cyan actions, gold rarity/rank details, and a safe-area-aware native Unity Canvas.

The six original background plates in `Assets/Resources/Art` correspond to title, first ride, partner naming, home paddock, scout reveal, and race result. Additional flat collection art covers tack, stable decor, course looks, weather, and feed/care. The wardrobe uses five rendered partner pairs from the 3D library. UI text and buttons remain Unity uGUI objects.

## Languages

Japanese is the first-launch default. The language switch stays available on every screen; it cycles through loaded locales and saves the choice with PlayerPrefs. Assets/Resources/Localization/ja.json contains Japanese overrides. English uses the source strings and en.json identifies the locale. Missing keys fall back to English.

To add a language, add Assets/Resources/Localization/{locale}.json with a locale code and an entries array of key/value pairs. Add all translated UI strings; untranslated strings intentionally fall back to English. The bundled Noto Sans CJK JP font covers Japanese, Korean, and Chinese ideographs plus kana and Latin UI text. The font subset and its license notice are in Assets/Resources/Fonts.

## Input

Keyboard: left/right arrows change lane, E uses a spur, and holding Space reins in. Touch: lane arrows, SPUR, and press-and-hold REIN.

Races run on the authoritative engine (`engine/Muchi.Engine`, imported as a local UPM package). The controls become engine inputs (`Assets/Muchi/Game/RaceInput.cs`): screen left/right → inside/outside lane (mirrored on right-handed courses), SPUR → START before the horse leaves the gate and WHIP afterwards, REIN hold → REIN_PRESS / REIN_RELEASE. The HUD (position, distance, stamina‰, whips, kakari, gate countdown) and the runner positions are read from the engine state; the first ride is the engine's 400 m tutorial preset, offline practice is a 12-runner 2000 m race, and online ranked races are lockstep races through the server. See [docs/handoff-unity-3d.md](../docs/handoff-unity-3d.md) for the full wiring.

## Server connection

`Assets/Resources/Muchi/server-config.json` selects the server (default: `local`, `http://127.0.0.1:8787`, dev auth with an auto-generated `x-dev-user`). Run the server with `cd server && npm ci && npm run dev`. Per device, PlayerPrefs `muchi.server.baseUrl` overrides the URL and `muchi.server.offline` = `1` forces offline mode. If the server is unreachable at start-up the app runs offline (local data, offline races). Staging/production need Firebase auth: import the Firebase Unity SDK (FirebaseAuth), add the scripting define `MUCHI_FIREBASE`, and call `await MuchiFirebase.InitializeAsync()` before `MuchiServices.Create()` (anonymous sign-in, Apple/Google linking and account switching; logic in `Assets/Muchi/Game/FirebaseAuth.cs`, SDK adapter in `Assets/Muchi/Integration/FirebaseSdkAuth.cs`). Without the define the app behaves as before.

## 3D asset library

`Assets/Art3D/build_asset_library.py` creates original procedural Blender assets: 25 combined horse-coat and jockey-silk FBX variants plus 25 reduced opponent LODs (five coat colors × five racing silks), five modular horse coats, five modular jockey looks, and a modular Greenfield trackside environment kit. Five featured pairs have studio renders under `Assets/Resources/Art/3DPreviews`. Blender source scenes are in `Assets/Art3D/Source` and the partner catalog is `Assets/Resources/Models/Partners/catalog.json`.

`RaceWorld` loads partner FBXs from Resources. The wardrobe stores the featured partner selection and shows its rendered 3D preview. The race uses that partner in the player slot, with varied lower-detail FBX partners in the other eleven CPU slots. Primitive horse geometry is retained as an import-failure fallback. The actual trackside kit has not yet replaced the procedural racecourse.

The Blender partner models have a source armature and `Gallop_Loop` action. Their separate geometry pieces are rigidly parented to bones rather than skin-weighted; `PartnerGallop` applies a lightweight runtime pose when imported transform names are preserved. Treat these assets and motion as a visual prototype requiring Unity import, rig, axis, lighting, mobile performance, and animation validation. The art is original procedural work and is not a licensed production character set.

For Blender rebuild steps, import-axis notes, and a concrete Unity validation list for the next implementer, see [Assets/Art3D/README.md](Assets/Art3D/README.md) and [the implementation handoff](../docs/handoff-unity-3d.md).

## Store and customization scope

The coin screen follows the planning doc's eight draft packs and separates paid from free balances. The ¥1,000/30-day pass uses free and premium tracks and displays its immediate outfit reward. Other direct cosmetic prices are labeled proposals. Checkout opens an age/billing review screen but remains disabled until platform billing, age-based caps, guardian consent, and product IDs are configured. No purchase is completed by this prototype.

Cosmetic rarity is N/R/SR/SSR and communicates collection identity. It does not increase ranked stats. Paid scouting is paused until the full probability table and item pool are supplied; the tutorial's first free draw is a fixed one-time preview. Weather, ground, temperature, wind, and care choices are saved as private-room presets; ranked conditions and stats stay equal for all entrants. A premium feed bowl is decor only. Private-room networking and weather simulation are not connected.

## Figma screen files

design/figma-screens/ contains 18 individual landscape SVG frames; muchi-figma-screens.zip bundles them. Japanese is the visible default. The SVGs embed art and preserve UI text and graphic overlays as separate vector elements. See design/README.md. New screens can be regenerated with `python3 design/export_monetization_screens.py`.

No Figma document was updated remotely: the Figma app tag was received, but Figma read/write tools are not present in this session's available tool list. The individual SVGs are ready to import into a Figma canvas.

## Validation

This environment has no Unity Editor or player runtime. Unity compilation, Play Mode, Android/iOS builds, and visual performance are unverified. Checks that run outside Unity with .NET 8 (also in CI):

    dotnet build 'Checks~/Muchi.Game'      # game layer, compiled like Unity (netstandard2.1, C# 9, no UnityEngine)
    dotnet build 'Checks~/UnityRuntime'    # Integration + Runtime scripts type-checked against UnityEngine 2022.3.62 reference assemblies
    dotnet run --project 'Checks~/GameChecks'                              # input, HUD, course placement, partner mapping, offline races
    dotnet run --project 'Checks~/GameChecks' -c Release -- online http://127.0.0.1:8787   # + naming, scout, shop, pass and a ranked race on a running server

The UnityEngine references come from a third-party NuGet redistribution (`RocketModFix.UnityEngine.Redist`) and are used only as compile-time references. These checks do not replace an Editor import, Play Mode, or device builds; real billing, Firebase auth and server-side cosmetics (wardrobe, course looks, care, conditions — marked LOCAL ONLY on screen) are not connected.
