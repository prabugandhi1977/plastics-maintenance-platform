# Draft translations (not enabled)

Tamil (`ta`) and Hindi (`hi`) drafts for the core labels and the field app: 404 phrases each.
They pass the validator (every key exists, `{placeholders}` and HTML markup match English exactly, correct script),
but they are **not yet wired into the app** and need review by a native-speaking maintenance engineer.

To enable a language later:
1. Merge the JSON into a `ta` / `hi` catalogue in `frontend/shared/i18n.js` and add it to `catalogues` and `LOCALES`.
2. Add the code to `LOCALES` in `backend/services/core/routes/auth.js`.
3. Run `python3 docs/translations-draft/validate.py <file>.json` after every edit.

Anything without a translation falls back to English automatically.
