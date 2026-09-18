# Vectis brand assets

`vectis.icon` is the Icon Composer source with the selected sand and copper palette. Native packaging compiles it with Xcode 26 or later into `Assets.car` and an `.icns` fallback for macOS 15. The originally supplied blue and lilac source is preserved in commit `assets: add original Vectis icon sources`.

`vectis.svg` is the original monochrome mark. `web/vectis.svg` applies the brand gradient to the same geometry; `web/vectis-light.svg` uses a deeper copper on light surfaces. These flat variants omit the native glass, shadow, and translucency effects.

Import `web/colors.css` for `--vectis-sand`, `--vectis-copper`, `--vectis-brand-on-light`, and `--vectis-brand-gradient`. These are brand colors, not general text or interactive-state tokens.

| Role                   | sRGB      | Display P3                                  |
| ---------------------- | --------- | ------------------------------------------- |
| Top, sand              | `#f1cc96` | `color(display-p3 0.92151 0.80538 0.61509)` |
| Bottom, copper         | `#b86b4c` | `color(display-p3 0.68021 0.43413 0.32205)` |
| Mark on light surfaces | `#85412a` | sRGB is sufficient                          |

The P3 values are converted from sRGB through linear-light RGB, not copied channel values. The matching native values live in `fill.linear-gradient` in `vectis.icon/icon.json`. Both web and native assets use the same color endpoints; native glass rendering may change their perceived appearance.

Keep a readable text label beside the mark. Test clear icons against their actual backdrop; a static gradient does not guarantee contrast under system tinting or transparency.
