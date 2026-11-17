# The disk image's Finder window, read by dmgbuild from package.sh.
# The two icons are the arguments of the command dmg-background.swift
# draws, and it names them just below; move one and move the other.

from pathlib import Path

dist = Path(defines["dist"])
app = dist / "fx.app"

format = "ULMO"
filesystem = "HFS+"
size = defines["size"]
shrink = False
files = [str(app)]
symlinks = {"Applications": "/Applications"}
icon = str(app / "Contents" / "Resources" / "AppIcon.icns")
background = str(dist / "dmg-background.png")
# Finder includes its 32-point title bar in the window bounds.
window_rect = ((200, 200), (640, 392))
default_view = "icon-view"
show_toolbar = False
show_sidebar = False
show_status_bar = False
show_pathbar = False
show_tab_view = False
arrange_by = None
icon_size = 96
text_size = 13
icon_locations = {"fx.app": (298, 124), "Applications": (450, 124)}
