# Font licences

Every face in this directory is licensed under the SIL Open Font License,
Version 1.1 (https://openfontlicense.org). The full licence text is in each
project's `OFL.txt` at the source repository named below.

| File | Family | Copyright | Source | Modified |
|---|---|---|---|---|
| `fraunces-variable.woff2`, `fraunces-italic-variable.woff2` | Fraunces | The Fraunces Project Authors | https://github.com/undercasetype/Fraunces | Latin subset |
| `dm-sans-variable.woff2` | DM Sans | The DM Sans Project Authors | https://github.com/googlefonts/dm-fonts | Latin subset |
| `dial-display-latin.woff2` | DialDisplay | Copyright 2019 The Big Shoulders Project Authors | https://github.com/xotypeco/big_shoulders | yes: instanced to wght 700-800, ascent/descent re-cut, renamed |
| `dial-text-latin.woff2` | DialText | Copyright 2022 The Bricolage Grotesque Project Authors | https://github.com/ateliertriay/bricolage | yes: instanced to wght 500-700, wdth 100, opsz 12-40, renamed |
| `azeret-mono-latin.woff2` | Azeret Mono | Copyright 2021 The Azeret Project Authors | https://github.com/displaay/azeret | Latin subset, not renamed |

`dial-display-latin.woff2` and `dial-text-latin.woff2` are Modified Versions
under the OFL, so they ship under new family names. The upstream `OFL.txt`
files for Big Shoulders and Bricolage Grotesque reserve no font name (checked
2026-10-06); the rename holds either way. Rebuild them with
`python tools/fonts/build-dial-fonts.py`.

The licence permits bundling these fonts with software, forbids selling them
on their own, and requires this notice to travel with them.
