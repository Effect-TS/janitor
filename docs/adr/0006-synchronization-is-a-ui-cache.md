# Use synchronization only as a UI cache

Status: accepted.

Synchronization exists solely to reduce GitHub requests when displaying information in Janitor. All automation must query GitHub directly, and synchronization readiness or failure must never gate automation. This trades additional automation API requests for independence from cache freshness and cache failures.

This applies across Janitor, including existing labeling and repository access checks. Connection, pause, valid GitHub access, and workflow enablement remain separate controls. The glossary describes the accepted destination, not a completed migration.

Before enabling issue review in production, complete the shared eligibility separation, move labeling to direct GitHub reads, and migrate Slack repository access checks. Review development may proceed alongside this work. This delays launch but avoids conflicting eligibility rules; removing synchronization checks alone would release labeling work that still depends on cached facts and synchronization safeguards.
