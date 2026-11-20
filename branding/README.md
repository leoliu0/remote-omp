# Branding — Remote OMP

Official visual identity assets ("Orbital Terminal Pulse"). Source of truth: SVG vector files.

## Palette

| Color | Hex | Usage |
|---|---|---|
| Midnight Navy | `#05070E` → `#13223A` | Adaptive icon background gradient (`#080D18` fallback color) |
| Cool Ice White | `#FFFFFF` → `#DCEEFF` → `#38BDF8` | Orbital ring & terminal chevron |
| Electric Cyan | `#7CF8FF` / `#00D4FF` / `#0EA5E9` | Live remote beacon, outer signal wave, cursor bar |

## Files

| File | Content | Recommended Usage |
|---|---|---|
| `logo-full.svg` | Midnight radial background + Orbital Terminal Pulse mark | Single-piece logo (iOS icon, README header, social/store preview) |
| `logo-foreground.svg` | Orbital Terminal Pulse mark on transparent background | Android adaptive icon foreground layer |
| `logo-background.svg` | Midnight navy + cyan aura radial background (1024×1024) | Android adaptive icon background layer |
| `logo-monochrome.svg` | Solid white silhouette | Android 13+ Material You themed icon |
| `banner.svg` / `banner.png` | 1280×640 horizontal banner | Package cards, README hero, social preview |

All logo files: **1024×1024** viewBox, Android adaptive-icon safe-zone compliant (outermost edge `r ≤ 291px`).

## PNG Conversion

```bash
# Via rsvg-convert
rsvg-convert -w 1024 -h 1024 logo-foreground.svg -o logo-foreground.png
rsvg-convert -w 1024 -h 1024 logo-background.svg -o logo-background.png
rsvg-convert -w 1024 -h 1024 logo-monochrome.svg -o logo-monochrome.png
rsvg-convert -w 1024 -h 1024 logo-full.svg -o logo-full.png
```

## Standard Export Sizes

| Platform | Size | Source File |
|---|---|---|
| iOS App Icon | 1024×1024 PNG (opaque RGB, no alpha) | `logo-full.svg` |
| Android Adaptive (background) | 108–432 PNG (`mipmap-mdpi`…`xxxhdpi`) | `logo-background.svg` |
| Android Adaptive (foreground) | 108–432 PNG transparent | `logo-foreground.svg` |
| Android Themed (monochrome) | 108–432 PNG transparent | `logo-monochrome.svg` |
| Favicon | 32×32, 16×16 PNG | `logo-full.svg` |
| npm registry README | 512×512 PNG | `logo-full.svg` |
