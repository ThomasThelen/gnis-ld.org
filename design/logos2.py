"""Builds a second set of GNIS-LD logo sketches, with letters and a map pin drawn as dense node networks."""

import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

import shapely
from shapely.geometry import LineString, MultiPoint, Point, Polygon


@dataclass
class Network:
    """
    Nodes and edges of a drawn network, in SVG user units.

    :param nodes: (x, y, radius) per node.
    :param edges: ((x1, y1), (x2, y2)) per edge.
    """

    nodes: list[tuple[float, float, float]] = field(default_factory=list)
    edges: list[tuple[tuple[float, float], tuple[float, float]]] = field(default_factory=list)

    def svg(self, edge_color: str, node_color: str, edge_width: float = 0.9, edge_opacity: float = 0.55) -> str:
        """
        Draws the network.

        :param edge_color: Color of the edges.
        :param node_color: Color of the nodes.
        :param edge_width: Width of the edges.
        :param edge_opacity: Opacity of the edges.
        :return: SVG elements.
        """
        lines = "".join(
            f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}"/>' for a, b in self.edges
        )
        dots = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>' for x, y, r in self.nodes)
        return (
            f'<g stroke="{edge_color}" stroke-width="{edge_width}" stroke-opacity="{edge_opacity}" stroke-linecap="round">{lines}</g>'
            f'<g fill="{node_color}">{dots}</g>'
        )


class Shapes:
    """
    Outlines of the letters L and D and of a map pin.
    """

    @staticmethod
    def bezier(p0, p1, p2, p3, steps: int = 40) -> list[tuple[float, float]]:
        """
        Samples a cubic Bezier curve.

        :param p0: Start point.
        :param p1: First control point.
        :param p2: Second control point.
        :param p3: End point.
        :param steps: Number of segments.
        :return: The sampled points, including both ends.
        """
        points = []
        for i in range(steps + 1):
            t = i / steps
            u = 1 - t
            points.append(tuple(u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d for a, b, c, d in zip(p0, p1, p2, p3)))
        return points

    @classmethod
    def letter_l(cls, x: float, y: float, h: float, stem: float) -> Polygon:
        """
        Builds the outline of an L.

        :param x: Left edge.
        :param y: Top edge.
        :param h: Cap height.
        :param stem: Stroke thickness.
        :return: The outline.
        """
        w = h * 0.62
        return Polygon([(x, y), (x + stem, y), (x + stem, y + h - stem), (x + w, y + h - stem), (x + w, y + h), (x, y + h)])

    @classmethod
    def letter_d(cls, x: float, y: float, h: float, stem: float) -> Polygon:
        """
        Builds the outline of a D, with its counter cut out.

        :param x: Left edge.
        :param y: Top edge.
        :param h: Cap height.
        :param stem: Stroke thickness.
        :return: The outline.
        """
        w = h * 0.8
        outer = [(x, y)] + cls.bezier((x + w * 0.4, y), (x + w * 1.05, y), (x + w * 1.05, y + h), (x + w * 0.4, y + h)) + [(x, y + h)]
        i = stem
        inner = [(x + i, y + i)] + cls.bezier((x + w * 0.4, y + i), (x + w * 1.05 - i * 1.3, y + i), (x + w * 1.05 - i * 1.3, y + h - i), (x + w * 0.4, y + h - i)) + [(x + i, y + h - i)]
        return Polygon(outer).difference(Polygon(inner))

    @classmethod
    def pin(cls, cx: float, cy: float, r: float, tip: float) -> Polygon:
        """
        Builds the outline of a map pin: a circular head tapering to a point.

        :param cx: Head center x.
        :param cy: Head center y.
        :param r: Head radius.
        :param tip: y of the point.
        :return: The outline.
        """
        # The tangent points from the tip to the head circle
        d = tip - cy
        angle = math.asin(r / d)
        start = math.pi / 2 + angle
        end = math.pi / 2 - angle + 2 * math.pi
        arc = [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in [start + (end - start) * i / 80 for i in range(81)]]
        return Polygon([(cx, tip)] + arc)


class Mesh:
    """
    Fills a shape with a triangulated network: nodes on its outline and
    inside it, joined by the Delaunay edges that lie inside the shape.
    """

    def __init__(self, seed: int) -> None:
        """
        Creates the builder.

        :param seed: Seed of the interior point jitter, so a sketch is the
            same on every build.
        """
        self.random = random.Random(seed)

    def build(self, shape: shapely.Geometry, spacing: float, interior: float, hubs: int = 4) -> Network:
        """
        Builds the network of a shape.

        :param shape: The shape, a Polygon or MultiPolygon.
        :param spacing: Distance between nodes on the outline.
        :param interior: Approximate distance between interior nodes.
        :param hubs: Number of larger nodes, at the points with most edges.
        :return: The network.
        """
        points: list[tuple[float, float]] = []
        polygons = shape.geoms if hasattr(shape, "geoms") else [shape]
        for ring in [r for poly in polygons for r in (poly.exterior, *poly.interiors)]:
            n = max(int(ring.length / spacing), 3)
            points += [ring.interpolate(i / n, normalized=True).coords[0] for i in range(n)]
        minx, miny, maxx, maxy = shape.bounds
        y = miny + interior / 2
        row = 0
        while y < maxy:
            x = minx + interior / 2 + (interior / 2 if row % 2 else 0)
            while x < maxx:
                px = x + self.random.uniform(-0.3, 0.3) * interior
                py = y + self.random.uniform(-0.3, 0.3) * interior
                if shape.buffer(-interior * 0.35).contains(Point(px, py)):
                    points.append((px, py))
                x += interior
            y += interior * 0.87
            row += 1
        edges = []
        inside = shape.buffer(0.6)
        for line in shapely.delaunay_triangles(MultiPoint(points), only_edges=True).geoms:
            if inside.contains(line):
                edges.append(tuple(line.coords))
        degree: dict[tuple[float, float], int] = {}
        for a, b in edges:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1
        ranked = sorted(degree, key=lambda p: -degree[p])
        big = set(ranked[:hubs])
        nodes = [(x, y, 2.8 if (x, y) in big else 1.7 + 0.3 * self.random.random()) for x, y in degree]
        return Network(nodes, edges)


class Constellation:
    """
    Traces a shape's centerline with evenly spaced nodes, joined along the
    line and to their nearest neighbors across it.
    """

    @staticmethod
    def build(lines: list[LineString], spacing: float, reach: float, hubs: list[tuple[float, float]]) -> Network:
        """
        Builds the network of a set of center lines.

        :param lines: The lines to trace.
        :param spacing: Distance between nodes along a line.
        :param reach: Maximum length of a cross edge between lines.
        :param hubs: Points drawn as larger nodes.
        :return: The network.
        """
        net = Network()
        all_points: list[tuple[float, float]] = []
        for line in lines:
            n = max(int(line.length / spacing), 1)
            points = [line.interpolate(i / n, normalized=True).coords[0] for i in range(n + 1)]
            net.edges += list(zip(points, points[1:]))
            all_points += points
        unique = list(dict.fromkeys((round(x, 1), round(y, 1)) for x, y in all_points))
        for i, a in enumerate(unique):
            near = sorted((math.dist(a, b), b) for b in unique[i + 1:] if 0 < math.dist(a, b) <= reach)
            for d, b in near[:1]:
                if d > spacing * 1.2:
                    net.edges.append((a, b))
        hub_set = {(round(x, 1), round(y, 1)) for x, y in hubs}
        net.nodes = [(x, y, 3.8 if (x, y) in hub_set else 2.5) for x, y in unique]
        return net


class LogoSheet:
    """
    Writes the comparison page of the second set of sketches.
    """

    NAVY, BLUE = "#154c79", "#2f80c3"

    def __init__(self, directory: Path) -> None:
        """
        Creates the sheet.

        :param directory: Directory the page is written to.
        """
        self.directory = directory

    def wordmark_mesh(self, dark: bool) -> str:
        """
        Draws "GNIS-" in type and "LD" as triangulated meshes.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 440 x 120 view box.
        """
        mesh = Mesh(7)
        shape = Shapes.letter_l(268, 28, 64, 14).union(Shapes.letter_d(316, 28, 64, 14))
        net = mesh.build(shape, 6.5, 9)
        text_color, edge, node = ("#e8f1fa", "#9cc7ec", "#6fb0e6") if dark else (self.NAVY, self.NAVY, self.BLUE)
        return (f'<text x="0" y="92" font-size="88" font-weight="600" letter-spacing="-1.5" fill="{text_color}">GNIS</text>'
                f'<rect x="219" y="59" width="26" height="9" rx="1.5" fill="{text_color}"/>' + net.svg(edge, node, 1.15, 0.85))

    def wordmark_constellation(self, dark: bool) -> str:
        """
        Draws "GNIS-" in type and "LD" as nodes traced along the letters'
        center lines, with cross links.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 440 x 120 view box.
        """
        top, bottom, x = 30, 90, 272
        l_line = LineString([(x, top), (x, bottom), (x + 38, bottom)])
        dx = 322
        d_curve = Shapes.bezier((dx, top), (dx + 64, top), (dx + 64, bottom), (dx, bottom))
        d_line = LineString([(dx, bottom), (dx, top)] + d_curve[1:])
        net = Constellation.build([l_line, d_line], 7.5, 16, [(x, top), (x, bottom), (x + 38, bottom), (dx, top), (dx, bottom), d_curve[20]])
        text_color, edge, node = ("#e8f1fa", "#9cc7ec", "#6fb0e6") if dark else (self.NAVY, self.NAVY, self.BLUE)
        return (f'<text x="0" y="92" font-size="88" font-weight="600" letter-spacing="-1.5" fill="{text_color}">GNIS</text>'
                f'<rect x="219" y="59" width="26" height="9" rx="1.5" fill="{text_color}"/>' + net.svg(edge, node, 2.3, 0.9))

    def pin_mesh(self, dark: bool) -> str:
        """
        Draws a map pin filled with a triangulated mesh.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 120 x 140 view box.
        """
        net = Mesh(11).build(Shapes.pin(60, 54, 42, 134), 7, 11, hubs=3)
        edge, node = ("#9cc7ec", "#6fb0e6") if dark else (self.NAVY, self.BLUE)
        return net.svg(edge, node, 0.9, 0.6)

    def pin_solid_mesh(self, dark: bool) -> str:
        """
        Draws a solid map pin with the triangulated mesh drawn on it in light
        lines, so the silhouette holds at favicon sizes.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 120 x 140 view box.
        """
        shape = Shapes.pin(60, 54, 42, 134)
        outline = " ".join(f"{x:.1f},{y:.1f}" for x, y in shape.exterior.coords)
        net = Mesh(11).build(shape.buffer(-3), 7.5, 11.5, hubs=3)
        fill, edge, node = ("#2f80c3", "#ffffff", "#ffffff") if dark else (self.NAVY, "#ffffff", "#9cc7ec")
        return f'<polygon points="{outline}" fill="{fill}"/>' + net.svg(edge, node, 0.9, 0.38)

    def pin_constellation(self, dark: bool) -> str:
        """
        Draws a map pin traced by nodes on its outline, with spokes from a
        hub node in its head.

        :param dark: Whether the colors are for a dark background.
        :return: SVG elements in a 120 x 140 view box.
        """
        outline = Shapes.pin(60, 54, 42, 134).exterior
        n = 26
        points = [outline.interpolate(i / n, normalized=True).coords[0] for i in range(n)]
        net = Network()
        net.edges += list(zip(points, points[1:] + points[:1]))
        hub = (60, 54)
        inner = [(60 + 21 * math.cos(math.radians(a)), 54 + 21 * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
        net.edges += [(hub, p) for p in inner]
        net.edges += list(zip(inner, inner[1:] + inner[:1]))
        for p in inner:
            nearest = min(points, key=lambda q: math.dist(p, q))
            net.edges.append((p, nearest))
        net.nodes = [(x, y, 1.9) for x, y in points] + [(x, y, 2.6) for x, y in inner] + [(hub[0], hub[1], 5.5)]
        edge, node = ("#9cc7ec", "#6fb0e6") if dark else (self.NAVY, self.BLUE)
        return net.svg(edge, node, 1.1, 0.65)

    def write(self) -> Path:
        """
        Writes logos-v2.html.

        :return: Path of the page.
        """
        cards = [
            ("3a · Mesh letters", "LD is filled with a triangulated network, like a low-poly model whose every vertex is a node. The letters keep their solid silhouette from a distance.", "wm", self.wordmark_mesh),
            ("3b · Constellation letters", "Nodes are spaced along the strokes of L and D, with links between neighbors, so the letters are traced by the network.", "wm", self.wordmark_constellation),
            ("4a · Mesh pin", "The pin's silhouette filled with a triangulated network.", "pin", self.pin_mesh),
            ("4b · Solid mesh pin", "A solid pin with the mesh drawn on it in light lines. It reads as a plain pin at favicon sizes and as a network up close.", "pin", self.pin_solid_mesh),
        ]
        html_cards = []
        for title, text, kind, draw in cards:
            box = "0 0 440 120" if kind == "wm" else "0 0 120 140"
            cls = "wordmark" if kind == "wm" else "symbol"
            sizes = ""
            if kind == "pin":
                sizes = '<div class="sizes">' + "".join(
                    f'<span class="tab"><svg width="{s}" height="{s}" viewBox="{box}">{draw(False)}</svg> {s} px</span>' for s in (16, 32, 64)) + "</div>"
            html_cards.append(
                f'<div class="card"><h3>{title}</h3><p>{text}</p>'
                f'<div class="stage"><svg class="{cls}" viewBox="{box}">{draw(False)}</svg></div>'
                f'<div class="stage dark"><svg class="{cls}" viewBox="{box}">{draw(True)}</svg></div>{sizes}</div>')
        lockup = (f'<div class="row" style="margin-top:16px"><div class="card"><h3>Lockup · 4b + 3a</h3><p>As in a site header.</p><div class="stage">'
                  f'<svg class="symbol small" viewBox="0 0 120 140">{self.pin_solid_mesh(False)}</svg>'
                  f'<svg class="wordmark mid" viewBox="0 0 440 120">{self.wordmark_mesh(False)}</svg></div></div>'
                  f'<div class="card"><h3>Lockup · 4a + 3b</h3><p>As in a site header.</p><div class="stage">'
                  f'<svg class="symbol small" viewBox="0 0 120 140">{self.pin_mesh(False)}</svg>'
                  f'<svg class="wordmark mid" viewBox="0 0 440 120">{self.wordmark_constellation(False)}</svg></div></div></div>')
        page = PAGE.replace("{{wordmarks}}", "".join(html_cards[:2])).replace("{{pins}}", "".join(html_cards[2:])).replace("{{lockup}}", lockup)
        path = self.directory / "logos-v2.html"
        path.write_text(page)
        return path


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNIS-LD logo sketches 2</title>
<style>
  body { margin: 0; background: #f2f6fa; color: #17263a; font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } .lede { color: #5b6b7e; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 28px 0 12px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: #fff; border: 1px solid #dde5ed; border-radius: 12px; padding: 18px 20px; }
  .card.wide { margin-top: 16px; }
  .card h3 { font-size: 14px; margin: 0 0 4px; } .card p { margin: 0 0 14px; color: #5b6b7e; font-size: 13px; }
  .stage { display: flex; align-items: center; justify-content: center; gap: 16px; min-height: 160px; border-radius: 8px; background: #fff; border: 1px solid #edf2f7; }
  .stage.dark { background: #0f2237; border-color: #0f2237; margin-top: 10px; }
  .sizes { display: flex; align-items: center; gap: 18px; margin-top: 12px; color: #5b6b7e; font-size: 12px; }
  .sizes .tab { display: flex; align-items: center; gap: 6px; background: #e9eef4; border-radius: 6px 6px 0 0; padding: 5px 10px; color: #17263a; }
  .wordmark { width: 400px; height: auto; } .symbol { width: 130px; height: auto; }
  .symbol.small { width: 58px; } .wordmark.mid { width: 260px; }
  svg text { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; }
</style></head>
<body><main>
<h1>GNIS-LD logo sketches, round 2</h1>
<p class="lede">Finer and denser: many small nodes and thin edges, with the letters and the pin emerging from the network. Generated from the shapes' outlines with a Delaunay triangulation.</p>
<h2>Wordmark</h2><div class="row">{{wordmarks}}</div>
<h2>Symbol</h2><div class="row">{{pins}}</div>
{{lockup}}
</main></body></html>
"""


if __name__ == "__main__":
    print(LogoSheet(Path(sys.argv[1])).write())
