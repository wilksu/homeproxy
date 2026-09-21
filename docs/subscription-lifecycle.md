# Subscription lifecycle quality guard

Subscription URLs, source metadata and nodes form one ownership transaction. A UI change is not complete merely
because a row disappeared: the checked apply must finish and the final UCI configuration must agree with the page.

## Invariants

1. A configured URL has at most one logical source after its `#fragment` is removed.
2. Subscription nodes are owned by `source_id`; legacy `grouphash` is the fallback.
3. Removing a URL removes its source metadata and all owned nodes in one save.
4. Any external reference blocks the entire removal without partial cache or DOM changes.
5. A single URL replacement preserves source identity; a title-only fragment change never changes ownership.
6. Multi-URL edits never guess pairings. Retired sources are removed, unchanged sources are retained and new URLs
   remain source-less until their first successful update.
7. Fetch, parse, validation, UCI save, core validation and service activation failures retain the last working data.
8. Checked apply owns its confirmation and final reload. Page code must not reload while confirmation is pending.

## Verification

Run the focused browser-side guard with:

```sh
npm run test:subscription
```

The normal `npm test` and GitHub build workflow also run these tests. Python/ucode subscription transaction tests run
in GitHub CI through `scripts/test-python.py`, which forbids skipped tests. The test names are the maintained lifecycle
matrix; do not duplicate it in this document.

## Container acceptance check

Before merging a change that affects subscription UI or ownership, use an isolated source and verify both outcomes:

1. Reference one of its nodes from a route, remove the URL and save. The URL must reappear with the exact reference
   listed, and `/etc/config/homeproxy` must remain unchanged.
2. Remove the reference, remove the URL again and use **Save current settings**. Wait for “Configuration changes
   applied” and the final LuCI reload. Confirm the URL, source section and all owned nodes are absent from
   `/etc/config/homeproxy` and that `uci changes homeproxy` is empty.
3. Reload the node and client pages at desktop and compact widths. Confirm source labels remain distinguishable,
   there is no orphan manual node, no horizontal overflow and no post-login console error.
4. Remove all fixtures and verify the service is still running before recording results.

This container check is intentionally about final persisted state; DOM disappearance or an RPC success alone is not
accepted as evidence.
