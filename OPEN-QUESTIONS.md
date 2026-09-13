# Open questions from the Ops Console restyle

Cases the identity in `docs/design/DESIGN.md` does not cover. Each one has
the neutral choice that shipped and what would settle it.

1. **Syntax highlighting in the policy and prompt editors.** DESIGN.md names
   no code theme. The editors keep CodeMirror's GitHub light and dark themes,
   which use their own blues, purples and reds, so the policy screen carries
   colours from outside the palette. Editor chrome (background, gutters,
   selection, active line, cursor) does use the tokens. Settle by choosing a
   two-tone highlight in `foreground` and `foreground-muted`, or by accepting
   the GitHub theme.

2. **Blueprint layout engine and YAML fallback.** DESIGN.md says node layout
   must come from a layout engine and the builder should fall back to YAML
   past a complexity cap. A rule is a fixed three-column chain (trigger,
   condition, actions), so the canvas uses a fixed column layout with computed
   wire endpoints. No YAML fallback exists for rules because rules have no
   YAML form. Settle when rules can branch.

3. **Switch track contrast.** The off track uses `foreground-faint`, which is
   2.2:1 against `surface`. DESIGN.md forbids lightening or changing it. The
   switch also carries a visible label, `aria-checked` and a focus ring, so
   state is never colour-only. Settle by darkening `foreground-faint` if a
   3:1 non-text ratio is required.

4. **`foreground-subtle` on `canvas`.** After darkening `foreground-subtle`
   one step to clear the lint's 4.5:1 check on `surface-muted`, it sits at
   4.36:1 on `canvas`. No shipped text uses that pair (subtle text sits on
   `surface` or `surface-muted`), but nothing prevents a future one. Settle by
   forbidding the pair in DESIGN.md or darkening the token again.

5. **Browser chrome colours.** `theme_color` in the web manifest and the two
   `theme-color` meta tags cannot reference CSS variables, so they carry the
   canvas hex values directly. These are the only literals outside the theme
   file.

6. **Sidebar drawer breakpoint.** DESIGN.md says the sidebar becomes a drawer
   below 820px. The sidebar primitive and Tailwind's `md:` variant switch at
   768px. Changing one without the other splits the layout, so both stay at
   768px. Settle by adding an `820px` breakpoint to the theme and moving the
   sidebar's `md:` classes to it.

7. **Inspector slide-over below 1240px.** The rule editor and policy editor
   inspectors stack under the main column below 1240px instead of becoming a
   slide-over triggered from the selection. A slide-over is a new interaction,
   which this restyle was told not to add.

8. **GitHub label colours.** The product owner keeps them. They render as a
   6px dot inside a neutral badge, so the badge text and fill stay in the
   palette. This is recorded in the DESIGN.md project notes.

9. **Mascot in the top bar.** The product owner keeps it. Recorded in the
   DESIGN.md project notes as the one exception to the no-mascot rule.

10. **Session title text.** Session titles are the first Slack message,
    truncated by the server. They are human-written prose, so they stay in
    Inter, but the session itself is agent work and carries the agent marker.
    DESIGN.md does not say how to treat human text inside an agent-owned row.

11. **Slack and GitHub messages.** DESIGN.md governs the web interface only.
    Comments, pull request bodies and Slack messages The Janitor posts carry
    no visible attribution beyond the platform's bot identity. Adding a
    signature line is a product decision, not a restyle.
