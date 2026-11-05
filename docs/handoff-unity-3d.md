# Unity 3D / Claude implementation handoff

Updated: 2026-11-05

## Current state

The Unity project is `unity/` and targets Unity 2022.3.62f1 with the Built-in Render Pipeline. The runtime front end is generated from `MuchiApp`; `RaceWorld` creates the course, camera, and twelve race slots. The browser front end in `frontend/` remains a separate screen-design prototype and is not embedded in Unity.

The race world now loads the original Blender-authored partner FBXs from `Assets/Resources/Models/Partners` at runtime. It uses the chosen full-detail partner in slot 0, fills the eleven CPU lanes with varied reduced-detail partner models, and falls back to primitive geometry only when no partner FBXs are imported. The wardrobe previews five featured coat/silk pairs rendered from the 3D assets. There are 25 combined horse-coat and jockey-silk FBX combinations in total, with one reduced-detail model for each opponent combination.

The partner FBXs include a Blender armature with rigidly bone-parented geometry and a `Gallop_Loop` source action. `PartnerGallop.cs` supplies a lightweight runtime pose for imported bone transforms when their names are present. This is prototype motion: meshes are not skin-weighted, the clip is not yet bound through a Unity Animator Controller, and no Unity runtime was available here to confirm the import hierarchy or motion axes.

## Files to inspect first

- `unity/README.md` — how to open, run, and validate the Unity prototype.
- `unity/Assets/Art3D/README.md` — asset catalog, rebuild steps, rig and axis notes, and recommended validation.
- `unity/Assets/Art3D/build_asset_library.py` — procedural Blender source for the horse, jockey, tack, previews, course kit, and 25 pair exports.
- `unity/Assets/Muchi/Runtime/RaceWorld.cs` — partner loading and race presentation.
- `unity/Assets/Muchi/Runtime/PartnerGallop.cs` — lightweight name-based gallop pose.
- `unity/Assets/Muchi/Runtime/MuchiApp.cs` — wardrobe selection, persisted partner, HUD, and screen navigation.
- `unity/design/figma-screens/` — 18 importable SVG screen frames. They are design files, not Unity screenshots.

## Validation needed in Unity Editor

1. Open `unity/` in Unity 2022.3.62f1 and wait for FBX import to finish. Choose **Muchi → Create Frontend Scene**, then enter Play Mode.
2. Check one partner in the wardrobe and on the track. Confirm the FBX forward axis, hoof contact with Y=0, size, material appearance, and visibility through the race camera. The exporter maps the Blender source's Z-up / +Y-forward scene into Unity's Y-up / +Z-forward world; `RaceWorld` applies a 180° yaw for the imported partner model. Adjust only after previewing the imported FBX.
3. Confirm Unity preserves the `Front_*`, `Hind_*`, `Jockey_Body`, and head transforms. If they are renamed or nested differently, update `PartnerGallop.Bind`; if they import as meshes only, configure the FBX rig and clip importer before using the runtime pose.
4. Test all 25 partners and the opponent LODs on mobile-target quality settings. Create optimized Unity prefabs, inspect materials and import settings, and profile draw calls, memory, and frame time.
5. Replace or upgrade the procedural box-built racecourse in `RaceWorld` with authored environment prefabs. `Greenfield_Trackside_Kit.fbx` is an importable modular art kit, but it is not yet connected to the runtime course.
6. Connect `RaceWorld` presentation and inputs to the authoritative race engine and server contracts. Current `RacePresentation` is local screen behavior only; player inventory, purchases, unlocks, weather simulation, and ranked matchmaking are not connected.

## Rebuild the source assets

With Blender 4.3+ installed:

```sh
cd unity
blender -b -t 4 -P Assets/Art3D/build_asset_library.py
```

This regenerates the 25 partner FBXs, 25 reduced opponent LODs, modular horse/jockey FBXs, five representative partner preview renders, the Greenfield trackside kit, and source `.blend` files. Blender may take several minutes on a CPU-only machine. No external art libraries are required.
