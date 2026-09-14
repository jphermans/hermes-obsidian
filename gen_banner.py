#!/usr/bin/env python3
"""Generate banner.png for the Hermes Agent Notes README.

Requires Pillow. Run from the plugin folder:  python3 gen_banner.py

Design: neutral dark slate canvas (no bright white, no oversaturated blue),
Obsidian-violet -> cyan accent, a programmatic illustration of a frontmatter
note travelling through the Hermes API server, and the author credit.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

W, H = 1280, 640
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "banner.png")

BG = (17, 23, 31, 255)
PANEL = (27, 36, 49, 255)
PANEL_EDGE = (46, 58, 77, 255)
WHITE = (240, 245, 250, 255)
MUTED = (139, 152, 170, 255)
FAINT = (96, 108, 126, 255)
VIOLET = (124, 58, 237)
CYAN = (34, 211, 238)


def load_font(size, candidates, index=0):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size, index=index)
        except (OSError, IOError, ValueError):
            continue
    return ImageFont.load_default()


HELVETICA = ["/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]
MONO = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SF-Mono.ttf"]
SF = ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/HelveticaNeue.ttc"]


def pick_bold(candidates, size):
    """A .ttc holds several faces; the bold one has the wider advance."""
    regular = load_font(size, candidates, 0)
    try:
        candidate = load_font(size, candidates, 1)
    except Exception:
        return regular
    try:
        if candidate.getlength("Hermes Agent Notes") > regular.getlength("Hermes Agent Notes"):
            return candidate
    except Exception:
        pass
    return regular


F_SUB = load_font(23, SF)
F_EYEBROW = load_font(15, SF)
F_PILL = load_font(16, SF)
F_NOTE_TITLE = pick_bold(SF, 21)
F_MONO = load_font(15, MONO)
F_MONO_SMALL = load_font(13, MONO)
F_CREDIT = load_font(17, SF)
F_CREDIT_BOLD = pick_bold(SF, 17)

# ── canvas ───────────────────────────────────────────────────────────────────
img = Image.new("RGBA", (W, H), BG)

# faint grid
grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gdraw = ImageDraw.Draw(grid)
for x in range(0, W, 32):
    gdraw.line([(x, 0), (x, H)], fill=(255, 255, 255, 5), width=1)
for y in range(0, H, 32):
    gdraw.line([(0, y), (W, y)], fill=(255, 255, 255, 5), width=1)
img = Image.alpha_composite(img, grid)

# soft violet glow behind the illustration
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([20, 90, 660, 570], fill=(124, 58, 237, 26))
img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(90)))

draw = ImageDraw.Draw(img)

# accent bar, violet -> cyan
for x in range(W):
    t = x / W
    bar = (int(VIOLET[0] + (CYAN[0] - VIOLET[0]) * t),
           int(VIOLET[1] + (CYAN[1] - VIOLET[1]) * t),
           int(VIOLET[2] + (CYAN[2] - VIOLET[2]) * t), 255)
    draw.rectangle([x, 0, x, 5], fill=bar)

# ── illustration: note card with frontmatter ─────────────────────────────────
card = [72, 148, 424, 476]
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([card[0] + 8, card[1] + 10, card[2] + 8, card[3] + 10],
                                         radius=16, fill=(0, 0, 0, 90))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14)))
draw = ImageDraw.Draw(img)

draw.rounded_rectangle(card, radius=16, fill=PANEL, outline=PANEL_EDGE, width=2)
draw.rounded_rectangle([card[0] + 18, card[1] + 1, card[2] - 18, card[1] + 5], radius=2, fill=(124, 58, 237, 210))

inner_x = card[0] + 22
y = card[1] + 26

# frontmatter block
for line in ["---", 'title: "Kitchen renovation"', "tags: [project/kitchen]", "created: 2026-09-14", "---"]:
    draw.text((inner_x, y), line, font=F_MONO_SMALL, fill=(150, 163, 181, 255))
    y += 20

y += 10
draw.text((inner_x, y), "Kitchen renovation", font=F_NOTE_TITLE, fill=WHITE)
y += 34

# body lines
for width in (300, 274, 236):
    draw.rounded_rectangle([inner_x, y, inner_x + width, y + 7], radius=3, fill=(58, 70, 88, 255))
    y += 18

y += 8

# wikilink + tag chips
link_text = "[[Boiler service]]"
link_w = int(draw.textlength(link_text, font=F_MONO)) + 22
draw.rounded_rectangle([inner_x, y, inner_x + link_w, y + 28], radius=14,
                       fill=(124, 58, 237, 46), outline=(124, 58, 237, 150))
draw.text((inner_x + 11, y + 6), link_text, font=F_MONO, fill=(196, 181, 253, 255))

tag_text = "#project/kitchen"
tag_x = inner_x + link_w + 10
tag_w = int(draw.textlength(tag_text, font=F_MONO)) + 20
draw.rounded_rectangle([tag_x, y, tag_x + tag_w, y + 28], radius=14,
                       fill=(34, 211, 238, 34), outline=(34, 211, 238, 120))
draw.text((tag_x + 10, y + 6), tag_text, font=F_MONO, fill=(165, 243, 252, 255))

# ── illustration: request hop to the agent ───────────────────────────────────
line_y = 312
x = card[2] + 26
while x < 548:
    draw.rounded_rectangle([x, line_y, x + 12, line_y + 3], radius=1, fill=(124, 58, 237, 210))
    x += 24
draw.polygon([(560, line_y - 9), (560, line_y + 9), (576, line_y + 2)], fill=(124, 58, 237, 230))
draw.text((card[2] + 26, line_y - 34), "POST /v1/chat/…", font=F_MONO_SMALL, fill=(150, 163, 181, 255))

# agent node
node = [590, 232, 730, 392]
nshadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(nshadow).rounded_rectangle([node[0] + 7, node[1] + 9, node[2] + 7, node[3] + 9],
                                          radius=22, fill=(0, 0, 0, 90))
img = Image.alpha_composite(img, nshadow.filter(ImageFilter.GaussianBlur(14)))
draw = ImageDraw.Draw(img)

draw.rounded_rectangle(node, radius=22, fill=(23, 31, 42, 255), outline=(124, 58, 237, 170), width=2)
cx, cy = (node[0] + node[2]) // 2, node[1] + 52
# four-point sparkle
draw.polygon([(cx, cy - 30), (cx + 8, cy - 8), (cx + 30, cy), (cx + 8, cy + 8),
              (cx, cy + 30), (cx - 8, cy + 8), (cx - 30, cy), (cx - 8, cy - 8)],
             fill=(167, 139, 250, 255))
draw.polygon([(cx, cy - 14), (cx + 4, cy - 4), (cx + 14, cy), (cx + 4, cy + 4),
              (cx, cy + 14), (cx - 4, cy + 4), (cx - 14, cy), (cx - 4, cy - 4)],
             fill=(240, 245, 250, 255))
label = "Hermes"
draw.text((cx - draw.textlength(label, font=F_MONO) / 2, node[1] + 100), label, font=F_MONO, fill=(196, 181, 253, 255))
label2 = "Agent"
draw.text((cx - draw.textlength(label2, font=F_MONO) / 2, node[1] + 120), label2, font=F_MONO, fill=(139, 152, 170, 255))

# return arrow underneath
y2 = 430
x = 560
while x > card[2] + 30:
    draw.rounded_rectangle([x - 12, y2, x, y2 + 3], radius=1, fill=(34, 211, 238, 170))
    x -= 24
draw.polygon([(card[2] + 22, y2 - 9), (card[2] + 22, y2 + 9), (card[2] + 6, y2 + 2)], fill=(34, 211, 238, 190))
draw.text((card[2] + 46, y2 - 26), "note file", font=F_MONO_SMALL, fill=(150, 163, 181, 255))

# ── text block ───────────────────────────────────────────────────────────────
tx = 800
draw.text((tx, 150), "O B S I D I A N   P L U G I N", font=F_EYEBROW, fill=(167, 139, 250, 255))

title = "Hermes Agent Notes"
size = 54
font_title = pick_bold(HELVETICA, size)
while draw.textlength(title, font=font_title) > 420 and size > 34:
    size -= 2
    font_title = pick_bold(HELVETICA, size)
draw.text((tx, 178), title, font=font_title, fill=WHITE)
title_h = size + 12

draw.text((tx, 178 + title_h + 18), "Write and fix Markdown notes with your", font=F_SUB, fill=(198, 208, 222, 255))
draw.text((tx, 178 + title_h + 50), "own Hermes Agent — local or remote.", font=F_SUB, fill=(198, 208, 222, 255))

# pills
pills = ["Obsidian 1.5+", "Desktop + mobile", "Vault-aware", "Local or remote", "MIT"]
px, py = tx, 178 + title_h + 104
for text in pills:
    pw = int(draw.textlength(text, font=F_PILL)) + 26
    if px + pw > W - 60:
        px, py = tx, py + 44
    draw.rounded_rectangle([px, py, px + pw, py + 34], radius=17,
                           fill=(38, 48, 63, 255), outline=(62, 76, 98, 255))
    draw.text((px + 13, py + 8), text, font=F_PILL, fill=(206, 216, 229, 255))
    px += pw + 10

# credit
cy2 = py + 96
draw.line([(tx, cy2 - 26), (W - 60, cy2 - 26)], fill=(46, 58, 77, 255), width=1)
draw.text((tx, cy2), "JPHsystems", font=F_CREDIT_BOLD, fill=(228, 235, 243, 255))
w_credit = draw.textlength("JPHsystems", font=F_CREDIT_BOLD)
draw.text((tx + w_credit + 12, cy2 + 1), "·  github.com/jphermans", font=F_CREDIT, fill=MUTED)

# faint symbols in the background
for text, pos, font, fill in [
    ("[[ ]]", (60, 78), load_font(40, MONO), (255, 255, 255, 12)),
    ("#tag", (1108, 40), load_font(30, MONO), (255, 255, 255, 10)),
    ("---", (1074, 552), load_font(34, MONO), (255, 255, 255, 10)),
    ("</>", (470, 540), load_font(28, MONO), (255, 255, 255, 9)),
]:
    draw.text(pos, text, font=font, fill=fill)

img.convert("RGB").save(OUT, "PNG", optimize=True)
print("wrote", OUT, os.path.getsize(OUT), "bytes", img.size)
