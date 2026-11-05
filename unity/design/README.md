# Figma screen files

The Unity visual direction is **console sports 3D**, with Japanese as the default display language. figma-screens/ contains separate landscape 16:9 frames for each screen:

1. Title
2. First ride tutorial
3. Partner naming
4. Free scout
5. Scout results
6. Home paddock
7. Stable / horse details
8. Race entry
9. Ranked race HUD
10. Race result
11. Jockey wardrobe
12. Course looks
13. Weather and ground settings
14. Stable care and feed
15. Coin shop
16. Cosmetic shop
17. Season pass
18. Purchase and age review

Each SVG embeds its background and keeps UI lettering and overlays as editable vector elements. Extract muchi-figma-screens.zip and drag the SVGs onto a Figma canvas. Each SVG becomes an individual screen frame with editable vector UI and embedded image art. PNG captures and contact-sheet.png are available for screens 01–10. Screens 11–18 are also provided as editable SVG, and the updated wardrobe frame embeds the five generated 3D partner previews.

title-screen-figma.svg is the standalone title layout. console-sports-ui-concept.png remains the original six-screen art-direction board.

These are screen designs for the Unity front end, not exported captures of a Unity player. Background plates remain static design art; the Unity wardrobe now uses five rendered 3D partner previews, and the race runtime loads the FBX partner library. Unity Editor and player rendering were unavailable in this cloud workspace.

Regenerate the original 10 screens, then the added screens, with `python3 design/export_figma_screens.py` and `python3 design/export_monetization_screens.py`. The Figma app tag is present, but this session's available tool list has no Figma read/write operations. No Figma document has been changed remotely; import the individual SVG frames into your document.
