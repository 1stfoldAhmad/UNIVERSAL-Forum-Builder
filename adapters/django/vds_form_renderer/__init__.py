"""VDS Universal Form Builder — Django server-rendered form renderer.

Produces the shared server-rendered HTML contract (enhanced by the same
hydration client as Node/Laravel) and submits through the trusted vds_form
execution adapter. Framework-free rendering core + thin Django view/tags.
"""
from .html import render_form, render_page, esc, localize, CSS
from .state import prepare_render_state
from .parse import parse_form_values
from .capabilities import DJANGO_CAPABILITY_MANIFEST

__all__ = ["render_form", "render_page", "esc", "localize", "CSS", "prepare_render_state",
           "parse_form_values", "DJANGO_CAPABILITY_MANIFEST"]
__version__ = "0.1.0"
default_app_config = "vds_form_renderer.apps.VdsFormRendererConfig"
