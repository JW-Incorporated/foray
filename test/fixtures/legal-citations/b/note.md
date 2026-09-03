# Fixture: sibling-resolution note (b)

The deliberate namesake of `test/fixtures/legal-citations/a/note.md`. Its
existence is what makes the basename `note.md` AMBIGUOUS in the repo (two
hits), so `resolveFile`'s basename fallback (strategy 3) cannot resolve it —
only the sibling-document-relative strategy (strategy 2) can, which is the
one property this fixture pair exists to isolate.
