# Ciao Bella translator artwork

The adopted icon is **08 · Symbol First**, selected by the project owner on 2026-10-16. It retains the C-shaped feminine character from the author's Ciao Bella developer identity, with the conventional “文 / A” translation symbol. The reference and generated source are included here specifically to make the artwork's origin and future maintenance reviewable.

- [Ciao Bella mother-brand reference](ciao-bella-original.png), adopted by the author on 2026-09-15.
- [08 generated source](08-source.png), made on 2026-10-16 with OpenAI's built-in `image_gen` tool. The mother-brand image above was its only image reference.
- [Exact generation prompt](prompt.txt), with no local runtime paths or account metadata.
- [Asset hashes and conversion record](provenance.json).

The Chinese character is 文 (U+6587), and the Latin character is uppercase A (U+0041). Google Material and Microsoft Fluent were studied for the familiar cross-script translation convention; neither library's SVG, type outlines, or logo geometry was copied. See [ACKNOWLEDGEMENTS.md](../../ACKNOWLEDGEMENTS.md).

The deployed files in `extension/icons/` are square Lanczos3 resizes of the selected source, with 128-colour PNG palette compression. The 256px `bella.png` is used in page controls, popup, and settings; 16/32/48/128px files serve browser UI. The opaque warm-ivory background is intentional. These files are raster artwork, not vector or transparent cutouts.

The project owner licenses the included mother-brand reference, generated derivative, and resized PNGs under the repository's [MIT copyright license](../../LICENSE), alongside the code and documentation. That license does not grant rights to use the Ciao Bella name or marks to imply endorsement or affiliation. No external stock image or font file is bundled.
