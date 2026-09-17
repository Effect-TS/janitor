# Allow explicit publication of dry-run results

Status: accepted.

The frontend offers Publish results for a saved dry-run result. Any frontend user with current effective write or admin permission on that repository may authorize publication, even if the original invoker has lost access. Record the original invoker and the publisher separately. This avoids repeating investigation solely to publish reviewed findings.

Publish the saved, validated findings and patch without repeating model work, subject to fresh repository and publication checks. Publication enters the same per-issue serialization as other writes. Repository pause, disconnection, unavailable access, or disabled issue review blocks publication.

An explicit action authorizes publication of only the selected result while repository dry-run may remain enabled. This is an exception to the earlier blanket prohibition on writes during dry-run. Dry-run still prevents automatic publication, and disabling it never automatically publishes saved results.

Only the latest invocation's completed result is publishable, within its 14-day retention window and with no newer active or queued invocation. The source invocation must still exist unchanged and the run must not have been cancelled. Older results remain viewable but cannot be published through this action. Repeated clicks reconcile or return the existing publication rather than create another one.
