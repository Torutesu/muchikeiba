# Muchi original 3D asset library

These procedural Blender assets provide a first in-game character set for the Unity prototype. They are original project geometry and renders, not licensed production character art.

## Asset inventory

| Group | Assets | Purpose |
|---|---:|---|
| Combined partners | 25 FBX models | Five coat variants × five racing-silk designs; loaded by `RaceWorld` |
| Opponent LODs | 25 reduced FBX models | Lower-polygon version of each pair for the eleven CPU lanes |
| Horse modules | 5 FBX models | Bay, chestnut, dapple grey, black, palomino |
| Jockey modules | 5 FBX models | Crimson, azure, violet, emerald, midnight gold |
| Trackside kit | 1 FBX model | Turf segment, rails, stands, starting gate, finish gantry and spectator silhouettes |
| Featured renders | 5 PNG images | Representative 3D-generated wardrobe thumbnails |
| Source scenes | 6 BLEND scenes | Five featured partner pairs and the trackside kit |

Partner model names follow `Partner_{Coat}_{Silk}.fbx`; opponent LODs use the matching `_LOD1` suffix. `Models/Partners/catalog.json` lists the full pair matrix. The five thumbnails pair each coat with one featured silk. The player gets the full model and AI lanes use the reduced counterpart when available.

## Runtime wiring

`Assets/Muchi/Runtime/RaceWorld.cs` loads `Resources/Models/Partners` and picks the stored featured partner for slot 0. Eleven opponents select from the imported set. If no partner FBXs are found, the old primitive blockout remains available as a fallback. The source meshes use Blender Z-up coordinates with the horse facing +Y; the FBX export maps them to Unity Y-up / +Z-forward, and `RaceWorld` adds a 180-degree yaw to partner model children. Verify this conversion in the Unity Editor before changing it.

The source armature has `Root`, `Body`, `Neck`, `Head`, four upper/lower leg pairs, tail, and jockey bones. Geometry is rigidly parented to bones, without skin weights. A looping Blender action is included; Unity has not yet been configured with an Animator Controller for that clip. `PartnerGallop` applies a small runtime pose by matching imported bone transform names. Check the imported FBX hierarchy and tune the pose in Unity before relying on it.

The wardrobe uses the five representative Blender renders as UI thumbnails. The separate Greenfield course kit is exported but not yet instantiated; the runtime track still uses procedural geometry. See [the Unity integration handoff](../../../docs/handoff-unity-3d.md) for the next verification and integration steps.

## Rebuild

Requires Blender 4.3 or later with its bundled FBX exporter. From the `unity/` directory run:

```sh
blender -b -t 4 -P Assets/Art3D/build_asset_library.py
```

The build script generates the 25 partner FBXs, 25 reduced opponent models, modular horse and jockey FBXs, five featured renders and blend sources, the partner catalog, and the trackside kit if it is missing. Rendering and export can take several minutes on CPU. Adjust `HORSES` and `SILKS` at the top of the script to add palettes and regenerate the complete combination set.
