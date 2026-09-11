from pathlib import Path

root = Path(defines["root"])
app = root / "dist" / "fx.app"

format = "ULMO"
filesystem = "HFS+"
size = defines["size"]
shrink = False
files = [str(app)]
symlinks = {"Applications": "/Applications"}
icon = str(app / "Contents" / "Resources" / "AppIcon.icns")
background = str(root / "dist" / "dmg-background.tiff")
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
icon_locations = {"fx.app": (176, 184), "Applications": (464, 184)}
