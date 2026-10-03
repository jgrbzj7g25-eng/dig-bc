# DIG BC
## Advanced Utils for Bandcamp

### `dig-bc-fixed.user.js`
A Tampermonkey/Greasemonkey userscript for Bandcamp, based on the upstream `DIG BC` script, with local fixes.

Current fixes include:
- disables unwanted auto-play when opening track, album, or collection pages
- fixes arrow-key browsing in collections so navigation moves by one item
- prevents keyboard shortcuts from interfering with typing in search fields and inputs
- avoids interfering with common browser shortcuts like `Ctrl+F` / `Cmd+F`
- adds `Shift+T` to wishlist the current track only

## Usage

### Userscript
1. Install a userscript manager such as Tampermonkey.
2. Create a new script.
3. Paste in the contents of `dig-bc-fixed.user.js`.
4. Save and open Bandcamp.

### Archive tool
See `bandcamp-archive/README.md` for details.

## Notes
- This repo is informal and focused on personal Bandcamp workflow improvements.
- Files may be standalone and not part of a larger packaged project.
