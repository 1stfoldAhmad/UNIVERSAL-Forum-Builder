"""Shared pytest configuration for the Django execution adapter.

The framework-free suites (expressions, validation, submission, policy, …) must
keep working when Django is NOT installed, so Django is configured only if it can
be imported.

When Django IS available it is configured with a REAL middleware stack
(Session → Authentication → CSRF) and a real URLconf, so view tests exercise
Django's actual request/response pipeline instead of calling a handler directly.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))  # import vds_form
sys.path.insert(0, HERE)                      # import django_urls as ROOT_URLCONF

try:
    import django
except ImportError:  # pragma: no cover - framework-free environments
    django = None

if django is not None:
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            SECRET_KEY="vds-form-test-secret",
            ROOT_URLCONF="django_urls",
            INSTALLED_APPS=[
                "django.contrib.contenttypes",
                "django.contrib.auth",
                "django.contrib.sessions",
            ],
            MIDDLEWARE=[
                "django.contrib.sessions.middleware.SessionMiddleware",
                "django.contrib.auth.middleware.AuthenticationMiddleware",
                "django.middleware.csrf.CsrfViewMiddleware",
            ],
            DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},
            DEFAULT_AUTO_FIELD="django.db.models.AutoField",
            PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
            USE_TZ=True,
        )
        django.setup()

    import pytest

    @pytest.fixture(scope="session")
    def django_db():
        """Create the auth/session tables once for the whole test session."""
        from django.core.management import call_command

        call_command("migrate", run_syncdb=True, verbosity=0, interactive=False)
        yield
