"""Template tags: {% load vds_form %}{% render_vds_form ir %}."""
from __future__ import annotations

from django import template
from django.utils.safestring import mark_safe

from ..html import render_form

register = template.Library()


@register.simple_tag(takes_context=True)
def render_vds_form(context, ir, **kwargs):
    request = context.get("request")
    if request is not None and "csrf_token" not in kwargs:
        from django.middleware.csrf import get_token
        kwargs["csrf_token"] = get_token(request)
    return mark_safe(render_form(ir, **kwargs))
