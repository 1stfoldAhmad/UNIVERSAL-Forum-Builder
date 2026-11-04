import json
import os

import pytest

from vds_form_renderer import render_form, render_page, parse_form_values, prepare_render_state, DJANGO_CAPABILITY_MANIFEST

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    with open(os.path.join(FIX, name + ".ir.json"), encoding="utf-8") as fh:
        return json.load(fh)


def test_renders_registration_fields():
    ir = load("customer-registration")
    html = render_form(ir, action="/forms/customer-registration")
    assert 'data-vds-form="customer-registration"' in html
    assert 'name="customer.name"' in html
    assert 'name="customer.email"' in html
    assert 'type="email"' in html
    for f in ir["fields"]:
        if not f.get("parentId") and f["type"] != "hidden":
            assert f'data-field-id="{f["id"]}"' in html


def test_invoice_repeater_rows_and_computed_totals():
    ir = load("invoice")
    values = {"items": [{"description": "A", "qty": 2, "price": 5}, {"description": "B", "qty": 3, "price": 4}]}
    html = render_form(ir, values=values)
    assert 'data-repeater="items"' in html
    assert 'data-row-index="0"' in html
    assert 'data-row-index="1"' in html
    assert 'name="items.0.qty"' in html
    assert 'name="items.1.price"' in html
    state = prepare_render_state(ir, values)
    assert state["values"]["items"][0]["lineTotal"] == 10
    assert state["values"]["subtotal"] == 22
    assert 'data-computed="total"' in html


def test_localization_and_escaping():
    ir = load("customer-registration")
    ir = json.loads(json.dumps(ir))
    ir["fields"][1]["label"] = {"fr": "Nom <script>", "en": "Name"}
    ir["fields"][1]["defaultValue"] = "<b>x</b>"
    html = render_form(ir, locale="fr")
    assert "Nom &lt;script&gt;" in html
    assert "&lt;b&gt;x&lt;/b&gt;" in html


def test_parse_urlencoded_nested_values():
    ir = load("customer-registration")
    data = {
        "customer.name": ["Ada"], "customer.email": ["ada@example.com"],
        "customer.type": ["individual"], "customer.consent": ["true"], "csrfmiddlewaretoken": ["tok"],
    }
    values = parse_form_values(ir, data)
    assert values["customer"]["name"] == "Ada"
    assert values["customer"]["consent"] is True
    assert "csrfmiddlewaretoken" not in values


def test_capability_manifest():
    assert DJANGO_CAPABILITY_MANIFEST["target"] == "django"
    assert "text" in DJANGO_CAPABILITY_MANIFEST["fieldTypes"]
    assert "signature" not in DJANGO_CAPABILITY_MANIFEST["fieldTypes"]
    assert DJANGO_CAPABILITY_MANIFEST["features"]["multiStep"] is True
