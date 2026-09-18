# Ignore review commands inside indented code fences

Commands shown as fenced code by GitHub Markdown must not invoke issue review. This includes tilde fences indented by one to three spaces. Direct commands outside those fences remain valid.

The scope is invocation parsing and regression coverage. No changes to authorization, publication, or review execution are needed.
