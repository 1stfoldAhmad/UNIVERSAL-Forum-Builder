# ADR-0001 — Repository, product name and package scope

Status: accepted · 2026-11-04

## Context
The specification asks for a new repository `VDS-Universal-Form-Builder`. The session is
bound to the existing checkout `1stfoldAhmad/UNIVERSAL-Forum-Builder` (empty initial commit:
LICENSE + README) and to branch `arena/1df95a3a-universal-forum-builder`. Creating a different
GitHub repository would detach all work from this session.

## Decision
- Implement the complete product **in this checkout**, on the session branch.
- Product name: **VDS Universal Form Builder**. npm scope: `@vds-form/*`. CLI: `vds-form`.
- Renaming the GitHub repo to `VDS-Universal-Form-Builder` is an owner settings action,
  recorded as a release-readiness task; it does not block implementation.
- The reference Expo library remains a separate, untouched repository/product.

## Consequences
All deliverables are preserved on the tracked branch; no irreversible public changes are made.
