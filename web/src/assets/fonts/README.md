# Terminal symbols

`SymbolsNerdFontMono-Regular.woff2` is the unmodified Symbols Nerd Font Mono from
[Nerd Fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly),
converted from TTF to WOFF2. The upstream MIT license is included in `LICENSE`.

Reproduce the conversion after downloading `SymbolsNerdFontMono-Regular.ttf` from
that release:

```sh
uvx --from 'fonttools[woff]==4.59.2' fonttools ttLib.woff2 compress SymbolsNerdFontMono-Regular.ttf -o SymbolsNerdFontMono-Regular.woff2
```

`PiTerminal.css` exposes only the private-use glyph ranges, so Powerline caps and
Nerd Font icons render without replacing ordinary text or changing its cell width.
The font is bundled with the app; no system font installation or external CDN is required.
