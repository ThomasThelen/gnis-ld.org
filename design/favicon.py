"""Builds favicon sketches: "GNIS" set in front of a large "LD" network backdrop."""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("logos2", HERE / "logos2.py")
logos2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(logos2)


class FaviconSheet:
    """
    Writes the favicon comparison page.
    """

    NAVY, BLUE = "#154c79", "#2f80c3"

    def backdrop_mesh(self, dark: bool) -> str:
        """
        Draws a large "LD" mesh across the lower part of a square.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 120 x 120 view box.
        """
        # L is 0.62 h wide. D is about 0.71 h wide.
        # The pair is centered with a gap of GAP between the L's foot and the D's stem.
        h, gap = 50, 6
        left = 60 - (0.62 * h + gap + 0.71 * h) / 2
        shape = logos2.Shapes.letter_l(left, 58, h, 11).union(logos2.Shapes.letter_d(left + 0.62 * h + gap, 58, h, 11))
        net = logos2.Mesh(5).build(shape, 6, 8.5, hubs=3)
        net.nodes = [(x, y, r * 0.8) for x, y, r in net.nodes]
        edge, node = ("#6fb0e6", "#6fb0e6") if dark else (self.BLUE, self.BLUE)
        return net.svg(edge, node, 1.0, 0.55)

    def mark(self, backdrop: str, dark: bool) -> str:
        """
        Draws a square tile with "GNIS" in front of a backdrop.

        :param backdrop: SVG elements of the backdrop.
        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 120 x 120 view box.
        """
        tile, text = ("#0f2237", "#ffffff") if dark else ("#e8f1fa", self.NAVY)
        return (f'<rect width="120" height="120" rx="22" fill="{tile}"/>' + backdrop +
                f'<text x="60" y="60" text-anchor="middle" font-size="38" font-weight="800" letter-spacing="-1" fill="{text}" '
                f'paint-order="stroke" stroke="{tile}" stroke-width="2" stroke-linejoin="round">GNIS</text>')

    def write(self) -> Path:
        """
        Writes favicon.html.

        :return: Path of the page.
        """
        variants = [("Mesh LD behind GNIS", self.backdrop_mesh)]
        cards = []
        for title, backdrop in variants:
            rows = []
            for dark in (False,):
                svg = self.mark(backdrop(dark), dark)
                sizes = "".join(f'<figure><svg width="{s}" height="{s}" viewBox="0 0 120 120">{svg}</svg><figcaption>{s} px</figcaption></figure>' for s in (180, 64, 32, 16))
                tab = f'<span class="tab"><svg width="16" height="16" viewBox="0 0 120 120">{svg}</svg> GNIS-LD</span>'
                rows.append(f'<div class="sizes {"dark" if dark else ""}">{sizes}{tab}</div>')
            cards.append(f'<div class="card"><h3>{title}</h3>{"".join(rows)}</div>')
        page = PAGE.replace("{{cards}}", "".join(cards))
        (HERE / "export").mkdir(exist_ok=True)
        (HERE / "export" / "favicon.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
            "<style>text { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; }</style>"
            + self.mark(self.backdrop_mesh(False), False) + "</svg>\n")
        path = HERE / "favicon.html"
        path.write_text(page)
        return path


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNIS-LD favicon sketches</title>
<style>
  body { margin: 0; background: #f2f6fa; color: #17263a; font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } .lede { color: #5b6b7e; margin: 0 0 24px; }
  .card { background: #fff; border: 1px solid #dde5ed; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
  .card h3 { font-size: 14px; margin: 0 0 12px; }
  .sizes { display: flex; align-items: flex-end; gap: 28px; padding: 16px; border-radius: 8px; border: 1px solid #edf2f7; }
  .sizes.dark { background: #0f2237; border-color: #0f2237; margin-top: 10px; color: #c9d8e6; }
  figure { margin: 0; text-align: center; } figcaption { font-size: 12px; color: #5b6b7e; margin-top: 4px; }
  .dark figcaption { color: #9fb3c8; }
  .tab { display: flex; align-items: center; gap: 7px; background: #e9eef4; color: #17263a; border-radius: 8px 8px 0 0; padding: 6px 12px; font-size: 12px; margin-left: auto; }
  svg text { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; }
</style></head>
<body><main>
<h1>GNIS-LD favicon sketches</h1>
<p class="lede">"GNIS" set in front of an "LD" mesh, placed a little lower as a backdrop. Shown at 180 px (app icon), 64, 32 and 16 px, and in a browser tab.</p>
{{cards}}
</main></body></html>
"""


if __name__ == "__main__":
    print(FaviconSheet().write())
