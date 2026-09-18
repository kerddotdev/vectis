# Vectis brand assets

`vectis.icon` is the Icon Composer source with the selected sand and copper palette. Native packaging compiles it with Xcode 26 or later into `Assets.car` and an `.icns` fallback for macOS 15. The originally supplied blue and lilac source is preserved in commit `assets: add original Vectis icon sources`.

`vectis.svg` is the original monochrome mark. `web/vectis.svg` applies the brand gradient to the same geometry; `web/vectis-light.svg` uses a deeper copper on light surfaces. These flat variants omit the native glass, shadow, and translucency effects.

The brand colors live in `packages/design/src/tokens.css` as `--vectis-sand`, `--vectis-copper`, and `--vectis-brand-gradient`, next to the semantic tokens. The deep copper mark color is the light-theme `--vectis-brand`. Use the semantic tokens for text and interactive states, not the raw brand colors.

| Role                   | sRGB      | Display P3                                  |
| ---------------------- | --------- | ------------------------------------------- |
| Top, sand              | `#f1cc96` | `color(display-p3 0.92151 0.80538 0.61509)` |
| Bottom, copper         | `#b86b4c` | `color(display-p3 0.68021 0.43413 0.32205)` |
| Mark on light surfaces | `#85412a` | sRGB is sufficient                          |

The P3 values are converted from sRGB through linear-light RGB, not copied channel values. The matching native values live in `fill.linear-gradient` in `vectis.icon/icon.json`. Both web and native assets use the same color endpoints; native glass rendering may change their perceived appearance.

Keep a readable text label beside the mark. Test clear icons against their actual backdrop; a static gradient does not guarantee contrast under system tinting or transparency.

## Contrast references

Against the current light surface `#faf9f6`, the deep copper mark `#85412a` measures 7.16:1. Against the dark surface `#16191e`, the sand and copper gradient endpoints measure 11.59:1 and 4.40:1 respectively. These are sRGB relative-luminance calculations for opaque flat colors, not measurements of the translucent native icon. The copper endpoint does not meet the 4.5:1 threshold for normal-size text on that dark surface.
