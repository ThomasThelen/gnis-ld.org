"""Builds the GNIS-LD wordmark: "GNIS-" in type and "LD" as a triangulated mesh."""

import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("logos2", HERE / "logos2.py")
logos2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(logos2)


class Wordmark:
    """
    Lays out and draws the wordmark from measurements of the rendered type.
    """

    NAVY, BLUE = "#154c79", "#2f80c3"
    FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif"
    SIZE, WEIGHT, TRACKING = 88, 600, -1.5
    BASELINE = 92
    # Space between "GNIS" and the hyphen, the hyphen and the L, and the L and the D
    GAP = 8
    HYPHEN_WIDTH, HYPHEN_HEIGHT = 22, 9
    # Stem thickness of the mesh letters, close to the stems of the type
    STEM = 13
    NODE_SCALE = 0.8
    # Space kept around the letters in the view box, and the depth of the
    # curves of G and S below the baseline
    MARGIN, DESCENT = 4, 2

    def __init__(self, measurements: dict) -> None:
        """
        Creates the layout.

        :param measurements: Measurements of "GNIS" rendered at SIZE, WEIGHT
            and TRACKING: "inkRight" (x of the rightmost ink) and "capHeight".
        """
        self.ink_right = measurements["inkRight"]
        self.cap = measurements["capHeight"]
        self.hyphen_x = self.ink_right + self.GAP
        self.l_x = self.hyphen_x + self.HYPHEN_WIDTH + self.GAP
        self.d_x = self.l_x + 0.62 * self.cap + self.GAP
        self.width = self.d_x + 0.71 * self.cap + 4

    def svg(self, dark: bool) -> str:
        """
        Draws the wordmark.

        :param dark: Whether the colors are for a dark background.
        :return: An SVG element.
        """
        top = self.BASELINE - self.cap
        shape = logos2.Shapes.letter_l(self.l_x, top, self.cap, self.STEM).union(
            logos2.Shapes.letter_d(self.d_x, top, self.cap, self.STEM))
        net = logos2.Mesh(7).build(shape, 6.5, 9)
        net.nodes = [(x, y, r * self.NODE_SCALE) for x, y, r in net.nodes]
        # The mesh uses the favicon's edge style: blue edges at partial opacity
        text, edge, node = ("#e8f1fa", "#6fb0e6", "#6fb0e6") if dark else (self.NAVY, self.BLUE, self.BLUE)
        # The hyphen is centered on half the cap height
        hyphen_y = self.BASELINE - self.cap * 0.45 - self.HYPHEN_HEIGHT / 2
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {top - self.MARGIN:.0f} {self.width:.0f} {self.cap + 2 * self.MARGIN + self.DESCENT:.0f}">'
            f'<text x="0" y="{self.BASELINE}" font-family="{self.FONT}" font-size="{self.SIZE}" font-weight="{self.WEIGHT}" letter-spacing="{self.TRACKING}" fill="{text}">GNIS</text>'
            f'<rect x="{self.hyphen_x:.1f}" y="{hyphen_y:.1f}" width="{self.HYPHEN_WIDTH}" height="{self.HYPHEN_HEIGHT}" rx="1.5" fill="{text}"/>'
            + net.svg(edge, node, 1.0, 0.55) + "</svg>"
        )

    def write(self) -> None:
        """
        Writes logo.html, a preview on light and dark backgrounds, and
        export/logo.svg and export/logo-dark.svg.
        """
        light, dark = self.svg(False), self.svg(True)
        (HERE / "export").mkdir(exist_ok=True)
        (HERE / "export" / "logo.svg").write_text(light + "\n")
        (HERE / "export" / "logo-dark.svg").write_text(dark + "\n")
        (HERE / "logo.html").write_text(PAGE.replace("{{light}}", light).replace("{{dark}}", dark))


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNIS-LD wordmark</title>
<style>
  body { margin: 0; background: #f2f6fa; font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #17263a; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 20px; }
  .stage { display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 44px 24px; border-radius: 12px; background: #fff; border: 1px solid #dde5ed; margin-bottom: 16px; }
  .stage.dark { background: #0f2237; border-color: #0f2237; }
  .big svg { width: 640px; height: auto; } .mid svg { width: 300px; height: auto; } .small svg { width: 150px; height: auto; }
</style></head>
<body><main>
<h1>GNIS-LD wordmark</h1>
<div class="stage"><div class="big">{{light}}</div><div class="mid">{{light}}</div><div class="small">{{light}}</div></div>
<div class="stage dark"><div class="big">{{dark}}</div><div class="mid">{{dark}}</div><div class="small">{{dark}}</div></div>
</main></body></html>
"""


if __name__ == "__main__":
    Wordmark(json.loads((HERE / "measure.json").read_text())).write()
