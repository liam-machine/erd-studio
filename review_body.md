## TLDR

:x: **CHANGES REQUESTED** - found 1 issue that should be fixed before merging.
- `deriveRelationshipAction` returns the wrong action for sourceStage=physical, status=missing, groundTruth=logical; the corresponding test also has the wrong expectation.